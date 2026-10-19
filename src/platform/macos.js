/**
 * macOS provider — lets the host run on a Mac with the same contract as the
 * Windows and Linux providers.
 *
 * Inventory reads .app bundles from the standard Applications folders, so no
 * permission prompt is needed to list apps. Running apps come from `ps`, mapped
 * back to their bundle path. Actions shell out through argv arrays only, the
 * same no-shell guarantee as the other providers; AppleScript sources are fixed
 * strings and any caller-derived value travels as a separate `osascript` argv
 * entry read through `on run argv`, never spliced into the script text.
 *
 * Some actions talk to other apps through Apple Events (quitting an app,
 * Spotify/Music playback, shutdown/restart), so macOS asks once for Automation
 * permission the first time each is used. Brightness has no built-in CLI on
 * macOS and reports itself unsupported.
 *
 * The touchpad, remote keyboard and signature insert run in a small Swift
 * helper (native/mac/MacDocInput.swift, built with `npm run build:mac`) that
 * posts CGEvents. It needs the Accessibility permission for whichever app
 * launched the host, and reports when that is missing.
 */

import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { cpus, freemem, homedir, tmpdir, totalmem } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateControl } from "./contract.js";
import { createMacInput } from "./input.js";

/** Apps that live outside the Applications folders but belong on a dock. */
const EXTRA_APPS = ["/System/Library/CoreServices/Finder.app"];

const APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  join(homedir(), "Applications"),
];

/** Players whose playback MacDoc can read and control by name. */
const PLAYERS = ["Spotify", "Music"];

export function appIdFromBundle(bundlePath) {
  return String(bundlePath || "").trim().toLowerCase();
}

/** Map `ps -axo pid=,comm=` output to running .app bundles. */
export function parseMacPs(raw) {
  const out = [];
  const seen = new Set();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const bundle = m[2].match(/^(.+?\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];
    if (!bundle || !Number.isInteger(pid) || pid <= 0) continue;
    // Helpers nested inside another bundle are not apps the user launched.
    if (/\.app\/.+\.app$/.test(bundle)) continue;
    const id = appIdFromBundle(bundle);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: basename(bundle, ".app"), title: "", pid, handle: 0, path: bundle });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

const VOLUME_STEP = 6;
const volumeBy = (delta) => [
  "on run argv",
  "set v to (output volume of (get volume settings)) + (item 1 of argv as integer)",
  "if v < 0 then set v to 0",
  "if v > 100 then set v to 100",
  "set volume output volume v",
  "end run",
].join("\n");

/** Control verbs mapped to concrete macOS argv. `player` is the active media app, if any. */
export const MAC_CONTROL = Object.freeze({
  "volume-up": () => ["osascript", ["-e", volumeBy(), String(VOLUME_STEP)]],
  "volume-down": () => ["osascript", ["-e", volumeBy(), String(-VOLUME_STEP)]],
  "volume-set": (v) => ["osascript", ["-e", "on run argv\nset volume output volume (item 1 of argv as integer)\nend run", String(v)]],
  "mute-toggle": () => ["osascript", ["-e", "set volume output muted (not output muted of (get volume settings))"]],
  "media-play-pause": (_, player) => playerCommand(player, "playpause"),
  "media-next": (_, player) => playerCommand(player, "next track"),
  "media-previous": (_, player) => playerCommand(player, "previous track"),
  "media-stop": (_, player) => playerCommand(player, "pause"),
  lock: () => ["pmset", ["displaysleepnow"]],
  sleep: () => ["pmset", ["sleepnow"]],
  shutdown: () => ["osascript", ["-e", 'tell application "System Events" to shut down']],
  restart: () => ["osascript", ["-e", 'tell application "System Events" to restart']],
});

function playerCommand(player, command) {
  if (!PLAYERS.includes(player)) throw Object.assign(new Error("Open Spotify or Music to control playback."), { status: 409 });
  // Both the player name and the command come from fixed allowlists above.
  return ["osascript", ["-e", `tell application "${player}" to ${command}`]];
}

/**
 * Fixed JXA source reading macOS's own now-playing service, which knows what
 * any app is playing (browsers, Spotify, Music, QuickTime, podcasts...).
 * `osascript` is an Apple binary, which this service still answers.
 * argv[0] === "art" returns the artwork as base64 instead of the details.
 */
const NOW_PLAYING_SCRIPT = `ObjC.import("Foundation");
function run(argv) {
  $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/MediaRemote.framework").load;
  const R = $.NSClassFromString("MRNowPlayingRequest");
  if (!R || R.isNil()) return "{}";
  const item = R.localNowPlayingItem;
  if (!item || item.isNil()) return "{}";
  const info = item.nowPlayingInfo;
  if (!info || info.isNil()) return "{}";
  const key = (name) => info.objectForKey("kMRMediaRemoteNowPlayingInfo" + name);
  if (argv[0] === "art") {
    const data = key("ArtworkData");
    if (!data || data.isNil()) return "";
    const mime = key("ArtworkMIMEType");
    return (mime && !mime.isNil() ? ObjC.unwrap(mime) : "image/jpeg") + ";" + ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  }
  const text = (name) => { const v = key(name); return v && !v.isNil() ? String(ObjC.unwrap(v)) : ""; };
  const number = (name) => { const v = key(name); return v && !v.isNil() ? Number(ObjC.unwrap(v)) : null; };
  const stamp = key("Timestamp");
  const url = key("AssetURL");
  const out = {
    title: text("Title"), artist: text("Artist"), album: text("Album"),
    duration: number("Duration"), elapsed: number("ElapsedTime"), rate: number("PlaybackRate"),
    at: stamp && !stamp.isNil() ? stamp.timeIntervalSince1970 * 1000 : null,
    file: url && !url.isNil() ? String(ObjC.unwrap(url.lastPathComponent)) : "",
    artwork: !!(key("ArtworkData") && !key("ArtworkData").isNil()),
    playing: R.localIsPlaying,
  };
  try { const client = R.localNowPlayingPlayerPath.client; out.bundleId = ObjC.unwrap(client.bundleIdentifier) || ""; out.appName = ObjC.unwrap(client.displayName) || ""; } catch (e) {}
  return JSON.stringify(out);
}`;

/** Posts a hardware media key (16 play/pause, 17 next, 18 previous); needs Accessibility. */
const MEDIA_KEY_SCRIPT = `ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run(argv) {
  const key = Number(argv[0]);
  for (const flags of [0xa00, 0xb00]) {
    const event = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, $.NSMakePoint(0, 0), flags, 0, 0, $(), 8, (key << 16) | flags, -1);
    $.CGEventPost(0, event.CGEvent);
  }
}`;

const tell = (bundleId, body) => `tell application id "${bundleId}"\n${body}\nend tell`;

/**
 * Players MacDoc can drive through their own scripting, keyed by bundle id.
 * Every script is a fixed string; volume values travel as argv.
 */
export const PLAYER_SCRIPTS = Object.freeze({
  "com.spotify.client": { toggle: "playpause", next: "next track", previous: "previous track", stop: "pause", getVolume: "sound volume", setVolume: "set sound volume to (item 1 of argv as integer)" },
  "com.apple.Music": { toggle: "playpause", next: "next track", previous: "previous track", stop: "pause", getVolume: "sound volume", setVolume: "set sound volume to (item 1 of argv as integer)" },
  "com.apple.TV": { toggle: "playpause", next: "next track", previous: "previous track", stop: "pause" },
  "com.apple.QuickTimePlayerX": { toggle: "tell document 1 to if playing then\npause\nelse\nplay\nend if", stop: "tell document 1 to pause", getVolume: "(audio volume of document 1) * 100 as integer", setVolume: "set audio volume of document 1 to ((item 1 of argv as integer) / 100)" },
  "org.videolan.vlc": { toggle: "play", next: "next", previous: "previous", stop: "stop", getVolume: "(audio volume * 100 / 256) as integer", setVolume: "set audio volume to ((item 1 of argv as integer) * 256 / 100) as integer" },
});
const MEDIA_ACTIONS = { "media-play-pause": ["toggle", 16], "media-next": ["next", 17], "media-previous": ["previous", 18], "media-stop": ["stop", 16] };

/** Built by `npm run build:mac`; MACDOC_AUDIO_HELPER overrides the location. */
export const MAC_AUDIO_HELPER = process.env.MACDOC_AUDIO_HELPER || fileURLToPath(new URL("../../MacDocAudio", import.meta.url));

/** Fixed JXA source; the bundle path and output file arrive as argv. */
const ICON_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const size = 256;
  const image = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(argv[1], true);
}`;

/** "Memory used" the way Activity Monitor counts it: app + wired + compressed pages. */
export function parseVmStat(raw, totalBytes) {
  const text = String(raw || "");
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label) => Number(text.match(new RegExp(label + ":\\s+(\\d+)"))?.[1]);
  const used = pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor");
  if (!Number.isFinite(used) || !pageSize || !(totalBytes > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((used * pageSize / totalBytes) * 100)));
}

/** Rolling CPU usage from the difference between two os.cpus() samples. */
function createCpuMeter() {
  let last = sample();
  function sample() {
    let idle = 0, total = 0;
    for (const { times } of cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
  }
  return () => {
    const next = sample();
    const total = next.total - last.total, idle = next.idle - last.idle;
    last = next;
    return total > 0 ? Math.round(((total - idle) / total) * 100) : null;
  };
}

/** Built by `npm run build:mac`; MACDOC_INPUT_HELPER overrides the location. */
export const MAC_INPUT_HELPER = process.env.MACDOC_INPUT_HELPER || fileURLToPath(new URL("../../MacDocInput", import.meta.url));

export function createMacProvider({ exec, appDirs = APP_DIRS, extraApps = EXTRA_APPS, inputHelperPath = MAC_INPUT_HELPER, audioHelperPath = MAC_AUDIO_HELPER, spawn } = {}) {
  if (typeof exec !== "function") throw new Error("macos provider requires exec");
  // pbpaste falls back to a legacy encoding without a UTF-8 locale.
  if (!/UTF-8/i.test(process.env.LC_ALL || process.env.LANG || "")) process.env.LANG = "en_US.UTF-8";
  const cpuUsage = createCpuMeter();

  async function running() {
    const { stdout } = await exec("ps", ["-axo", "pid=,comm="]);
    return parseMacPs(stdout);
  }

  async function mediaNow() {
    try {
      const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", NOW_PLAYING_SCRIPT, "info"]);
      const raw = JSON.parse(String(stdout).trim() || "{}");
      if (!raw.bundleId && !raw.title) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async function playerVolume(bundleId) {
    const script = PLAYER_SCRIPTS[bundleId]?.getVolume;
    if (!script) return null;
    try {
      const value = Number(String((await exec("osascript", ["-e", tell(bundleId, "return " + script)])).stdout).trim());
      return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
    } catch {
      return null;
    }
  }

  async function activePlayer() {
    const names = new Set((await running().catch(() => [])).map((app) => app.name));
    return PLAYERS.find((name) => names.has(name)) || null;
  }

  return {
    id: "macos",
    displayName: "macOS",
    input: createMacInput({ helperPath: inputHelperPath, ...(spawn ? { spawn } : {}) }),

    async listInstalledApps() {
      const byId = new Map();
      for (const dir of appDirs) {
        let entries;
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith(".app")) continue;
          const target = join(dir, entry);
          const id = appIdFromBundle(target);
          if (!byId.has(id)) {
            byId.set(id, { id, name: basename(entry, ".app"), target, args: "", icon: "", source: "applications" });
          }
        }
      }
      for (const target of extraApps) {
        const id = appIdFromBundle(target);
        try {
          await readdir(target);
          if (!byId.has(id)) byId.set(id, { id, name: basename(target, ".app"), target, args: "", icon: "", source: "system" });
        } catch {
          /* not present on this Mac */
        }
      }
      return [...byId.values()].sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
      );
    },

    listRunningApps() {
      return running();
    },

    async launchApp(app) {
      const target = typeof app === "string" ? app : app?.target;
      if (typeof target !== "string" || !target.endsWith(".app")) {
        throw new Error("launchApp requires an .app bundle path");
      }
      await exec("open", ["-a", target]);
    },

    async focusApp(app) {
      // `open -a` on a running app brings it to the front without relaunching it.
      if (typeof app?.path !== "string" || !app.path.endsWith(".app")) {
        throw new Error("focusApp requires a running app bundle");
      }
      await exec("open", ["-a", app.path]);
    },

    async closeApp(app) {
      // A polite quit lets the app offer to save, like WM_CLOSE on Windows.
      if (typeof app?.path !== "string" || !app.path.endsWith(".app")) {
        throw new Error("closeApp requires a running app bundle");
      }
      await exec("osascript", ["-e", "on run argv\ntell application (item 1 of argv) to quit\nend run", app.path]);
    },

    async control(verb, value) {
      const checked = validateControl(verb, value);
      if (!checked.ok) throw new Error(checked.error);
      if (checked.verb === "brightness-set") {
        throw Object.assign(new Error("Brightness isn't supported on macOS yet."), { status: 409 });
      }
      const build = MAC_CONTROL[checked.verb];
      if (!build) throw new Error(`unmapped control verb: ${checked.verb}`);
      if (MEDIA_ACTIONS[checked.verb]) {
        // Drive whichever app macOS says is playing; fall back to the media key.
        const [action, mediaKey] = MEDIA_ACTIONS[checked.verb];
        const now = await mediaNow();
        const script = PLAYER_SCRIPTS[now?.bundleId]?.[action];
        if (script) await exec("osascript", ["-e", tell(now.bundleId, script)]);
        else if (!now && await activePlayer()) await exec(...build(checked.value, await activePlayer()));
        else await exec("osascript", ["-l", "JavaScript", "-e", MEDIA_KEY_SCRIPT, String(mediaKey)]);
        return { ok: true, verb: checked.verb };
      }
      const [file, args] = build(checked.value, null);
      await exec(file, args);
      return { ok: true, verb: checked.verb };
    },

    async nowPlaying() {
      const now = await mediaNow();
      if (!now) return null;
      const title = now.title || now.file.replace(/\.[a-z0-9]+$/i, "") || now.appName;
      if (!title) return null;
      return {
        title,
        artist: now.artist || (now.title ? "" : now.appName) || "",
        album: now.album || "",
        app: now.appName || "",
        bundleId: now.bundleId || "",
        playing: Boolean(now.playing),
        duration: Number.isFinite(now.duration) && now.duration > 0 ? now.duration : null,
        // Report the position as of now, so devices with a different clock can count on from it.
        elapsed: Number.isFinite(now.elapsed)
          ? now.elapsed + (now.playing && Number.isFinite(now.at) ? Math.max(0, (Date.now() - now.at) / 1000) * (now.rate || 1) : 0)
          : null,
        rate: Number.isFinite(now.rate) ? now.rate : (now.playing ? 1 : 0),
        artwork: Boolean(now.artwork),
        controllable: Boolean(PLAYER_SCRIPTS[now.bundleId]),
      };
    },

    async nowPlayingArtwork() {
      try {
        const out = String((await exec("osascript", ["-l", "JavaScript", "-e", NOW_PLAYING_SCRIPT, "art"])).stdout).trim();
        const split = out.indexOf(";");
        if (split < 1) return null;
        const type = out.slice(0, split);
        if (!/^image\/(png|jpeg|jpg|gif|webp|heic)$/i.test(type)) return null;
        return { type: type.toLowerCase(), data: Buffer.from(out.slice(split + 1), "base64") };
      } catch {
        return null;
      }
    },

    async audioMixer() {
      const [output, listed] = await Promise.all([
        exec("osascript", ["-e", "set s to get volume settings\nreturn (output volume of s as text) & \",\" & (output muted of s as text)"])
          .then(({ stdout }) => { const [volume, muted] = String(stdout).trim().split(","); return { volume: Number(volume), muted: muted === "true" }; })
          .catch(() => ({ volume: null, muted: false })),
        exec(audioHelperPath, ["list"]).then(({ stdout }) => JSON.parse(stdout)).catch(() => null),
      ]);
      const apps = [];
      for (const entry of listed || []) {
        const adjustable = Boolean(PLAYER_SCRIPTS[entry.bundleId]?.setVolume);
        // Show what is making sound now, plus players MacDoc can turn up or down.
        if (!entry.playing && !adjustable) continue;
        apps.push({
          id: appIdFromBundle(entry.app),
          name: entry.name,
          bundleId: entry.bundleId,
          playing: Boolean(entry.playing),
          adjustable,
          volume: adjustable ? await playerVolume(entry.bundleId) : null,
        });
      }
      return { output, apps, helper: listed !== null };
    },

    async setAppVolume(bundleId, volume) {
      const script = PLAYER_SCRIPTS[bundleId]?.setVolume;
      if (!script) throw Object.assign(new Error("That app doesn't let MacDoc change its volume yet."), { status: 409 });
      if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw Object.assign(new Error("volume must be 0..100"), { status: 400 });
      await exec("osascript", ["-e", "on run argv\n" + tell(bundleId, script) + "\nend run", String(volume)]);
    },

    async readClipboard() {
      const { stdout } = await exec("pbpaste", []);
      return stdout;
    },

    async writeClipboard(text) {
      if (typeof text !== "string") throw new Error("writeClipboard requires text");
      // The text travels as its own argv entry, never inside the script source.
      await exec("osascript", ["-e", "on run argv\nset the clipboard to (item 1 of argv)\nend run", text]);
    },

    async appIcon(app) {
      // NSWorkspace renders the icon Finder shows, including apps whose real
      // artwork lives in an asset catalog behind a placeholder .icns file.
      const target = app?.target;
      if (typeof target !== "string" || !target.endsWith(".app")) return null;
      let dir;
      try {
        dir = await mkdtemp(join(tmpdir(), "macdoc-icon-"));
        const out = join(dir, "icon.png");
        await exec("osascript", ["-l", "JavaScript", "-e", ICON_SCRIPT, target, out]);
        return await readFile(out);
      } catch {
        return null;
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    async systemStats() {
      let battery = null, charging = null;
      try {
        const { stdout } = await exec("pmset", ["-g", "batt"]);
        const percent = stdout.match(/(\d+)%/);
        if (percent) battery = Number(percent[1]);
        if (percent) charging = /charging|charged|AC Power/i.test(stdout) && !/discharging/i.test(stdout);
      } catch {
        /* desktops have no battery */
      }
      const total = totalmem();
      let memory = total > 0 ? Math.round(((total - freemem()) / total) * 100) : null;
      try { memory = parseVmStat((await exec("vm_stat", [])).stdout, total) ?? memory; } catch { /* keep the rough figure */ }
      return {
        cpu: cpuUsage(),
        memory,
        battery,
        charging,
      };
    },
  };
}
