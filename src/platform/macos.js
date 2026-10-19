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

export function createMacProvider({ exec, appDirs = APP_DIRS, extraApps = EXTRA_APPS, inputHelperPath = MAC_INPUT_HELPER, spawn } = {}) {
  if (typeof exec !== "function") throw new Error("macos provider requires exec");
  // pbpaste falls back to a legacy encoding without a UTF-8 locale.
  if (!/UTF-8/i.test(process.env.LC_ALL || process.env.LANG || "")) process.env.LANG = "en_US.UTF-8";
  const cpuUsage = createCpuMeter();

  async function running() {
    const { stdout } = await exec("ps", ["-axo", "pid=,comm="]);
    return parseMacPs(stdout);
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
      const player = checked.verb.startsWith("media-") ? await activePlayer() : null;
      const [file, args] = build(checked.value, player);
      await exec(file, args);
      return { ok: true, verb: checked.verb };
    },

    async nowPlaying() {
      // Only ask a player that is already open, so polling never launches one.
      const player = await activePlayer();
      if (!player) return null;
      try {
        const { stdout } = await exec("osascript", ["-e", [
          `tell application "${player}"`,
          "if player state is stopped then return \"\"",
          "return (player state as text) & tab & (artist of current track) & tab & (name of current track)",
          "end tell",
        ].join("\n")]);
        const [status, artist, title] = String(stdout).trim().split("\t");
        if (!title) return null;
        return { title, artist: artist || "", playing: status === "playing" };
      } catch {
        return null;
      }
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
