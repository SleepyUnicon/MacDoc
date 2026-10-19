import { renderAppIcon, escapeHtml } from "./dock.js";
import { icon } from "./icons.js";
import { addAppTile, removeTile } from "./tiles.js";

/**
 * The welcome home: what MacDoc does, with the host's apps underneath so a new
 * dock can be filled in one place. It appears whenever the dock is empty and
 * stays open while apps are being picked, until "Open my dock".
 */
export function createWelcome({ api, commitTiles, notify, report }) {
  const $ = (id) => document.getElementById(id);
  let apps = null, loading = null, open = false, tiles = [], hostLabel = "your Mac";

  const pinnedIds = () => new Set(tiles.filter((tile) => tile.kind === "app").map((tile) => tile.id));

  function draw() {
    if (!open) return;
    const pinned = pinnedIds();
    $("welcome-done").disabled = pinned.size === 0;
    if (!apps) return;
    const term = $("welcome-filter").value.trim().toLowerCase();
    const matches = term ? apps.filter((app) => app.name.toLowerCase().includes(term)) : apps;
    $("welcome-count").textContent = apps.length + " apps on " + hostLabel + " · " + (pinned.size ? pinned.size + " on your dock" : "tap to add");
    $("welcome-apps").innerHTML = matches.length
      ? matches.map((app) => '<li><button type="button" data-id="' + escapeHtml(app.id) + '" aria-pressed="' + pinned.has(app.id) + '">' + renderAppIcon(app, true) + '<span class="welcome__check">' + icon("check") + "</span><span>" + escapeHtml(app.name) + "</span></button></li>").join("")
      : '<li class="welcome__empty">No apps match that name.</li>';
  }

  async function load() {
    loading ??= api("/api/apps/installed").then(({ apps: list }) => { apps = list; draw(); })
      .catch((error) => { loading = null; $("welcome-count").textContent = "Couldn't load your apps. Reopen MacDoc to try again."; report(error); });
    return loading;
  }

  function show(visible) {
    if (open === visible) return;
    open = visible;
    $("welcome").hidden = !visible;
    document.body.classList.toggle("has-welcome", visible);
    if (visible) { draw(); load(); }
  }

  $("welcome-filter").addEventListener("input", draw);
  $("welcome-apps").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-id]");
    const app = apps?.find((item) => item.id === button?.dataset.id);
    if (!app || button.disabled) return;
    const adding = button.getAttribute("aria-pressed") !== "true";
    if (adding && tiles.length >= 64) return notify("Your dock is full. Remove an app before adding another.", true);
    button.disabled = true;
    try { await commitTiles(adding ? addAppTile(tiles, app) : removeTile(tiles, "app:" + app.id)); }
    catch (error) { report(error); }
    finally { button.disabled = false; }
  });
  $("welcome-done").addEventListener("click", () => show(false));

  return {
    /** Called on every paint with the latest dock state. */
    sync(state, paired) {
      tiles = state.tiles || [];
      hostLabel = state.hostName || "your Mac";
      if (!paired) show(false);
      else if (!tiles.length) show(true);
      draw();
    },
  };
}

/** Plays the opening animation, then removes it; a tap or key press skips it. */
export function playIntro(element, { duration = 2550 } = {}) {
  if (!element) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { element.remove(); return; }
  let done = false;
  const finish = (fast) => {
    if (done) return;
    done = true;
    if (fast) element.classList.add("is-leaving");
    setTimeout(() => element.remove(), fast ? 360 : 0);
  };
  const timer = setTimeout(() => finish(false), duration);
  const skip = () => { clearTimeout(timer); finish(true); };
  element.addEventListener("pointerdown", skip, { once: true });
  addEventListener("keydown", skip, { once: true });
}
