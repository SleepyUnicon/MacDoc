/**
 * Browser playback on macOS.
 *
 * Some browsers (Brave by default) never tell macOS what they are playing, so
 * the system media key goes to whichever app last did, which can wake an old
 * Safari session instead. When the audio helper reports a browser making
 * sound, MacDoc finds the tab with the playing <video>/<audio> through the
 * browser's own AppleScript and acts on that tab.
 *
 * That needs "Allow JavaScript from Apple Events" (View > Developer in
 * Chromium browsers, the Develop menu in Safari); without it MacDoc reports
 * exactly which setting to turn on. Every AppleScript source is fixed and
 * built from the allowlist below; the page script travels as argv.
 */

/** Browsers MacDoc can drive, keyed by bundle id. */
export const BROWSERS = Object.freeze({
  "com.brave.Browser": { name: "Brave Browser", kind: "chromium", menu: "View > Developer > Allow JavaScript from Apple Events" },
  "com.google.Chrome": { name: "Google Chrome", kind: "chromium", menu: "View > Developer > Allow JavaScript from Apple Events" },
  "com.microsoft.edgemac": { name: "Microsoft Edge", kind: "chromium", menu: "View > Developer > Allow JavaScript from Apple Events" },
  "company.thebrowser.Browser": { name: "Arc", kind: "chromium", menu: "View > Developer > Allow JavaScript from Apple Events" },
  "com.vivaldi.Vivaldi": { name: "Vivaldi", kind: "chromium", menu: "View > Developer > Allow JavaScript from Apple Events" },
  "com.operasoftware.Opera": { name: "Opera", kind: "chromium", menu: "View > Developer > Allow JavaScript from Apple Events" },
  "com.apple.Safari": { name: "Safari", kind: "safari", menu: "Develop > Developer Settings > Allow JavaScript from Apple Events" },
});

/** macOS reports some players through a helper; map those back to the app. */
export const MEDIA_OWNERS = Object.freeze({
  "com.apple.WebKit.GPU": "com.apple.Safari",
  "com.apple.WebKit.WebContent": "com.apple.Safari",
});

/**
 * The browser that actually runs a player. Web apps installed from Chromium
 * browsers (a YouTube app from Brave, say) report their own bundle id, such as
 * com.brave.Browser.app.<id>, but play inside a window of the parent browser.
 */
export function mediaOwner(bundleId) {
  if (!bundleId) return null;
  if (MEDIA_OWNERS[bundleId]) return MEDIA_OWNERS[bundleId];
  const webApp = Object.keys(BROWSERS).find((browser) => BROWSERS[browser].kind === "chromium" && bundleId.startsWith(browser + ".app."));
  return webApp || bundleId;
}

const SELECTORS = {
  next: [".ytp-next-button", "ytmusic-player-bar .next-button", "[data-testid=control-button-skip-forward]", ".skipControl__next"],
  previous: [".ytp-prev-button", "ytmusic-player-bar .previous-button", "[data-testid=control-button-skip-back]", ".skipControl__previous"],
};

/**
 * The page script. `want` is "playing" (only a tab with media playing answers)
 * or "paused" (a tab with paused media that has already started answers).
 * It returns "" when this tab has nothing to say, so the loop moves on.
 */
export function pageScript(action, want) {
  return `(() => {
  const media = [...document.querySelectorAll("video, audio")];
  const m = ${want === "playing" ? "media.find((x) => !x.paused && !x.ended)" : "media.find((x) => x.paused && x.currentTime > 0 && !x.ended)"};
  if (!m) return "";
  const meta = navigator.mediaSession && navigator.mediaSession.metadata;
  const click = (list) => { for (const s of list) { const b = document.querySelector(s); if (b) { b.click(); return true; } } return false; };
  const act = ${JSON.stringify(action)};
  if (act === "toggle") { if (m.paused) m.play(); else m.pause(); }
  else if (act === "stop") m.pause();
  else if (act === "next" && !click(${JSON.stringify(SELECTORS.next)})) m.currentTime = Math.min(m.duration || 0, m.currentTime + 10);
  else if (act === "previous" && !click(${JSON.stringify(SELECTORS.previous)})) m.currentTime = Math.max(0, m.currentTime - 10);
  const playing = act === "toggle" ? !m.paused : act === "stop" ? false : !m.paused;
  return JSON.stringify({
    title: (meta && meta.title) || document.title || location.hostname,
    artist: (meta && meta.artist) || (meta && meta.title ? document.title : location.hostname),
    album: (meta && meta.album) || "",
    playing,
    duration: Number.isFinite(m.duration) ? m.duration : null,
    elapsed: m.currentTime,
  });
})()`;
}

/** Fixed AppleScript that runs argv[1] in each tab until one answers. */
function tabLoop(bundleId) {
  const { kind } = BROWSERS[bundleId];
  const run = kind === "safari" ? "set r to do JavaScript js in t" : "set r to execute t javascript js";
  return [
    "on run argv",
    "set js to item 1 of argv",
    `tell application id "${bundleId}"`,
    "repeat with w in windows",
    "repeat with t in tabs of w",
    run,
    'if r is not missing value and r is not "" then return r',
    "end repeat",
    "end repeat",
    "end tell",
    'return ""',
    "end run",
  ].join("\n");
}

export function createBrowserMedia({ exec }) {
  async function inTabs(bundleId, action, want) {
    try {
      const { stdout } = await exec("osascript", ["-e", tabLoop(bundleId), pageScript(action, want)]);
      const text = String(stdout).trim();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (/JavaScript.*(turned off|Apple Events)|not allowed|-1743/i.test(String(error.stderr || error.message))) {
        const browser = BROWSERS[bundleId];
        throw Object.assign(new Error(`To control ${browser.name} from MacDoc, turn on ${browser.menu} in ${browser.name}.`), { status: 409, needsPermission: true });
      }
      throw Object.assign(new Error(`${BROWSERS[bundleId].name} didn't respond. Try again.`), { status: 409 });
    }
  }

  return {
    supports: (bundleId) => Object.hasOwn(BROWSERS, bundleId),
    name: (bundleId) => BROWSERS[bundleId]?.name || "",

    /** What the browser is playing, or null. A missing permission is reported, not thrown. */
    async nowPlaying(bundleId) {
      try {
        const info = await inTabs(bundleId, "probe", "playing") || await inTabs(bundleId, "probe", "paused");
        return info ? { ...info, app: BROWSERS[bundleId].name, bundleId, controllable: true } : null;
      } catch (error) {
        if (!error.needsPermission) return null;
        return { title: "Playing in " + BROWSERS[bundleId].name, artist: error.message, album: "", playing: true, duration: null, elapsed: null, app: BROWSERS[bundleId].name, bundleId, controllable: false };
      }
    },

    /** Toggle, stop, next or previous in the tab that is playing (or was last). */
    async act(bundleId, action) {
      const done = await inTabs(bundleId, action, "playing") || (action === "toggle" ? await inTabs(bundleId, action, "paused") : null);
      if (!done) throw Object.assign(new Error(`Nothing is playing in ${BROWSERS[bundleId].name}.`), { status: 409 });
      return done;
    },
  };
}
