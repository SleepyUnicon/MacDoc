import { renderAppIcon, escapeHtml } from "./dock.js";
import { icon } from "./icons.js";

const SWIPE = 45;       // px of travel that opens or closes a panel
const MIXER_POLL = 2500;

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds), h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = String(whole % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + s : m + ":" + s;
}

/**
 * Side pages of the dock: swipe in from the left edge for the music player,
 * from the right edge for the clipboard and the Mac's sound. Swiping back
 * toward the edge, the close tab or Escape closes them.
 */
export function createPanels({ api, notify, report, clipboard, isReady }) {
  const $ = (id) => document.getElementById(id);
  const panels = { player: $("player-panel"), mixer: $("mixer-panel") };
  let openName = null, media = null, mixerTimer = null, tick = null, artKey = "", volumeBusy = false, outputMuted = false;

  // ---------- open / close ----------
  function open(name) {
    if (!isReady() || openName === name) return;
    if (openName) close(true);
    openName = name;
    const panel = panels[name];
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("is-open"));
    document.body.classList.add("has-panel");
    startMixer();
    if (name === "mixer") clipboard.open().catch(report);
    if (name === "player") { paintPlayer(); tick = setInterval(paintProgress, 500); }
  }
  function close(immediate = false) {
    if (!openName) return;
    const panel = panels[openName], name = openName;
    openName = null;
    panel.classList.remove("is-open");
    document.body.classList.remove("has-panel");
    clearInterval(mixerTimer); mixerTimer = null;
    clearInterval(tick); tick = null;
    if (name === "mixer") clipboard.close();
    const hide = () => { if (!panel.classList.contains("is-open")) panel.hidden = true; };
    if (immediate) hide(); else setTimeout(hide, 320);
  }

  // ---------- gestures ----------
  function edgeSwipe(handle, name, direction) {
    let start = null;
    handle.addEventListener("pointerdown", (event) => { start = { id: event.pointerId, x: event.clientX, y: event.clientY }; handle.setPointerCapture?.(event.pointerId); });
    handle.addEventListener("pointerup", (event) => {
      if (start?.id !== event.pointerId) return;
      const dx = (event.clientX - start.x) * direction, dy = Math.abs(event.clientY - start.y);
      const tap = Math.abs(event.clientX - start.x) < 8 && dy < 8;
      start = null;
      if (tap || (dx > SWIPE && dx > dy)) open(name);
    });
    handle.addEventListener("pointercancel", () => { start = null; });
  }
  edgeSwipe($("edge-left"), "player", 1);
  edgeSwipe($("edge-right"), "mixer", -1);

  for (const [name, panel] of Object.entries(panels)) {
    const closing = name === "player" ? -1 : 1; // the player closes by swiping left
    let start = null;
    panel.addEventListener("pointerdown", (event) => {
      if (event.target.closest("input, textarea, button, a, [data-clip]")) return;
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    panel.addEventListener("pointerup", (event) => {
      if (start?.id !== event.pointerId) return;
      const dx = (event.clientX - start.x) * closing, dy = Math.abs(event.clientY - start.y);
      start = null;
      if (dx > SWIPE * 1.5 && dx > dy * 1.5) close();
    });
    panel.addEventListener("pointercancel", () => { start = null; });
    panel.querySelector("[data-panel-close]").addEventListener("click", () => close());
  }
  addEventListener("keydown", (event) => { if (event.key === "Escape" && openName) close(); });

  // ---------- player ----------
  function elapsedNow() {
    if (!media || !Number.isFinite(media.elapsed)) return null;
    const rate = media.playing ? (media.rate || 1) : 0;
    const value = media.elapsed + Math.max(0, (Date.now() - media.at) / 1000) * rate;
    return media.duration ? Math.min(value, media.duration) : value;
  }
  function paintProgress() {
    const elapsed = elapsedNow();
    $("player-elapsed").textContent = clock(elapsed ?? 0);
    $("player-duration").textContent = media?.duration ? clock(media.duration) : "–:––";
    $("player-bar").style.width = media?.duration && elapsed !== null ? Math.min(100, (elapsed / media.duration) * 100) + "%" : "0%";
  }
  function paintPlayer() {
    const has = Boolean(media?.title);
    $("player-app").textContent = has ? (media.playing ? "Playing" : "Paused") + (media.app ? " in " + media.app : "") : "Nothing playing";
    $("player-title").textContent = has ? media.title : "Play something on your Mac";
    $("player-artist").textContent = has ? [media.artist, media.album].filter(Boolean).join(" · ") : "Music, podcasts and videos from any app show up here.";
    $("player-toggle").innerHTML = icon(media?.playing ? "pause" : "play");
    $("player-note").textContent = has && !media.controllable ? (media.app || "This app") + " can't be controlled from MacDoc yet." : "";
    const key = has && media.artwork ? [media.title, media.artist, media.album].join("|") : "";
    if (key !== artKey) {
      artKey = key;
      $("player-art").hidden = !key;
      $("player-art-empty").hidden = Boolean(key);
      if (key) $("player-art").src = "/api/nowplaying/artwork?k=" + encodeURIComponent(key);
      else $("player-art").removeAttribute("src");
    }
    panels.player.classList.toggle("is-playing", Boolean(media?.playing));
    paintProgress();
  }
  $("player-art").addEventListener("error", () => { $("player-art").hidden = true; $("player-art-empty").hidden = false; });
  panels.player.querySelectorAll("[data-player]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api("/api/control", { method: "POST", body: JSON.stringify({ verb: button.dataset.player }) });
      if (media && button.dataset.player === "media-play-pause") { media = { ...media, elapsed: elapsedNow(), at: Date.now(), playing: !media.playing }; paintPlayer(); }
    } catch (error) { report(error); } finally { button.disabled = false; }
  }));

  // ---------- sound ----------
  function paintOutput(output) {
    if (!output || !Number.isFinite(output.volume)) return;
    outputMuted = output.muted;
    for (const [slider, value, mute] of [["player-volume", "player-volume-value", "player-mute"], ["mixer-output", "mixer-output-value", "mixer-mute"]]) {
      if (!volumeBusy) $(slider).value = output.volume;
      $(value).textContent = output.muted ? "Muted" : output.volume + "%";
      $(mute).innerHTML = icon(output.muted ? "mute" : "volume");
      $(mute).setAttribute("aria-pressed", String(output.muted));
    }
  }
  function paintApps(apps) {
    $("mixer-apps").innerHTML = apps.length ? apps.map((app) => {
      const id = escapeHtml(app.bundleId), level = app.muted ? "Muted" : Number.isFinite(app.volume) ? app.volume + "%" : "";
      return '<li class="mixer__app">' + renderAppIcon(app) +
        '<div class="mixer__app-body"><div class="mixer__row-head"><strong>' + escapeHtml(app.name) + '</strong><span>' + (app.playing ? '<i class="mixer__live"></i>Playing' : "Quiet") + (app.adjustable && level ? " · " + level : "") + "</span></div>" +
        (app.adjustable
          ? '<div class="mixer__slider"><button type="button" data-app-mute="' + id + '" aria-pressed="' + Boolean(app.muted) + '" aria-label="' + (app.muted ? "Unmute " : "Mute ") + escapeHtml(app.name) + '">' + icon(app.muted ? "mute" : "volume") + "</button>" +
            '<input type="range" min="0" max="100" step="1" value="' + (app.volume ?? 100) + '" data-app-volume="' + id + '" data-muted="' + Boolean(app.muted) + '" aria-label="' + escapeHtml(app.name) + ' volume"></div>'
          : '<p class="mixer__follows">Follows the Mac volume</p>') +
        "</div></li>";
    }).join("") : '<li class="mixer__empty">No app is playing sound right now.</li>';
  }
  async function refreshMixer() {
    if (!openName) return;
    try {
      const mixer = await api("/api/audio");
      paintOutput(mixer.output);
      if (openName === "mixer" && !document.activeElement?.matches?.("[data-app-volume]")) paintApps(mixer.apps);
      $("mixer-status").textContent = !mixer.helper ? "Run npm run build:mac on the Mac to list apps with sound."
        : mixer.mixer?.message || "What's playing on your Mac, and how loud.";
    } catch (error) {
      $("mixer-status").textContent = error.message;
    }
  }
  function startMixer() { clearInterval(mixerTimer); refreshMixer(); mixerTimer = setInterval(refreshMixer, MIXER_POLL); }

  let volumeTimer = null;
  function setOutput(value) {
    volumeBusy = true;
    for (const id of ["player-volume", "mixer-output"]) $(id).value = value;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(async () => {
      try { await api("/api/control", { method: "POST", body: JSON.stringify({ verb: "volume-set", value: Number(value) }) }); }
      catch (error) { report(error); }
      finally { volumeBusy = false; refreshMixer(); }
    }, 120);
  }
  for (const id of ["player-volume", "mixer-output"]) $(id).addEventListener("input", (event) => setOutput(event.target.value));
  for (const id of ["player-mute", "mixer-mute"]) $(id).addEventListener("click", async () => {
    try { await api("/api/control", { method: "POST", body: JSON.stringify({ verb: "mute-toggle" }) }); paintOutput({ volume: Number($("mixer-output").value), muted: !outputMuted }); }
    catch (error) { report(error); }
  });
  const appTimers = new Map();
  function setApp(bundleId, change) {
    return api("/api/audio/app", { method: "POST", body: JSON.stringify({ bundleId, ...change }) }).catch((error) => {
      // A missing permission belongs in the column's status, where it stays until fixed.
      if (error.status === 403) $("mixer-status").textContent = error.message;
      else notify(error.message, true);
    });
  }
  $("mixer-apps").addEventListener("input", (event) => {
    const slider = event.target.closest("[data-app-volume]");
    if (!slider) return;
    const bundleId = slider.dataset.appVolume;
    clearTimeout(appTimers.get(bundleId));
    appTimers.set(bundleId, setTimeout(() => {
      // Moving a muted app's slider turns it back on.
      const change = { volume: Number(slider.value) };
      if (slider.dataset.muted === "true") { change.muted = false; slider.dataset.muted = "false"; }
      setApp(bundleId, change);
    }, 80));
  });
  $("mixer-apps").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-app-mute]");
    if (!button) return;
    const muted = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(muted));
    button.innerHTML = icon(muted ? "mute" : "volume");
    button.disabled = true;
    await setApp(button.dataset.appMute, { muted });
    button.disabled = false;
    refreshMixer();
  });
  $("mixer-apps").addEventListener("change", () => setTimeout(refreshMixer, 300));

  return {
    open,
    close,
    get openName() { return openName; },
    /** Feed every now-playing update in, so the player stays current. */
    update(next) { media = next && next.title ? { ...next, at: Date.now() } : null; if (openName === "player") paintPlayer(); },
  };
}
