import { renderNowPlaying, renderControlPicker, renderAppIcon, renderControls, escapeHtml } from "./dock.js";
import { icon, controlIcon } from "./icons.js";
import { addAppTile, addControlTile, removeTile, moveTile, toWireTiles, availableControls, tileKey } from "./tiles.js";
import { GRIDS, normalizeLayout, renderPages, pageCount, moveToTile, movePage } from "./launcher.js";
import { createInputPad } from "./input-pad.js";
import { createNowPlayingPoller } from "./now-playing.js";
import { createClipboardSheet } from "./clipboard.js";
import { createWelcome, playIntro } from "./welcome.js";
import { createPanels } from "./panels.js";

const $ = (id) => document.getElementById(id);
let state = { tiles: [], running: [], verbs: [] };
let editing = false, paired = false, online = false, saving = false;
let socket = null, reconnectTimer = null, installedApps = [], appsLoaded = false;
let currentPage = 0, toastTimer, selectedKey = "", suppressClickUntil = 0;
let pageHintTimer;
let captureState = { available: false, phase: "idle" }, captureBusy = false, capturePoll = false, captureReceivedAt = Date.now();
let nowPlayingHtml = "";
const nowPlaying = createNowPlayingPoller({
  load: async (signal) => (await api("/api/nowplaying", { signal })).nowPlaying,
  isActive: () => paired && online && !document.hidden,
  onChange: (media) => {
    const html = renderNowPlaying(media);
    // Keep the playback button (and its focus) when nothing has changed.
    if (nowPlayingHtml !== html) { $("nowplaying").innerHTML = html; nowPlayingHtml = html; }
    panels.update(media);
  },
});
let layout;
try { layout = normalizeLayout(JSON.parse(localStorage.getItem("macdoc-layout"))); } catch { layout = normalizeLayout(); }
playIntro($("intro"));
const welcome = createWelcome({ api, commitTiles, notify, report });
document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement && event.target.closest(".app-icon")) event.target.parentElement.classList.add("icon-failed");
}, true);

function notify(message, error = false) {
  clearTimeout(toastTimer);
  const el = $("toast");
  el.textContent = message;
  el.dataset.error = String(error);
  // Native dialogs occupy the top layer; feedback belongs inside the active one.
  (Array.from(document.querySelectorAll("dialog[open]")).at(-1) || document.body).append(el);
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 5500 : 2700);
}
function report(error) {
  if (error.message === "unauthorized") return;
  notify(error.message === "Failed to fetch" ? "Connection lost. Check that MacDoc is running on your Mac." : error.message, true);
}
function captureActive() { return ["starting", "recording", "stopping"].includes(captureState.phase); }
function captureTime() {
  const seconds = Math.floor(((captureState.elapsedMs || 0) + (captureState.phase === "recording" ? Date.now() - captureReceivedAt : 0)) / 1000);
  return Math.floor(seconds / 60).toString().padStart(2, "0") + ":" + (seconds % 60).toString().padStart(2, "0");
}
function paintCapture() {
  const active = captureActive();
  const waiting = ["starting", "stopping"].includes(captureState.phase);
  $("recording-stop").hidden = !paired || !active;
  $("recording-stop").disabled = !online || captureBusy || waiting;
  $("recording-time").textContent = !online ? "Reconnecting…" : waiting ? (captureState.phase === "starting" ? "Starting…" : "Saving…") : captureTime();
  $("capture-screenshot").disabled = !online || !captureState.available || captureBusy || waiting;
  $("capture-record").disabled = !online || !captureState.available || captureBusy || waiting;
  $("capture-record").classList.toggle("is-recording", active);
  $("capture-record-icon").innerHTML = icon(active ? "stop" : "record");
  $("capture-record-label").textContent = active ? (waiting ? (captureState.phase === "starting" ? "Starting…" : "Saving recording…") : "Stop recording") : "Start recording";
  $("capture-record-detail").textContent = active ? captureTime() + " · Video only" : "MP4 · Video only";
  $("capture-status").textContent = !online ? "PC disconnected. Any recording continues on the PC. Reconnect or stop from its tray menu." : captureState.error || (!captureState.available ? "Screen capture is available with the Windows host." : active ? "Recording your main monitor. Stop to save the video." : "Screenshots → Pictures / MacDoc. Recordings → Videos / MacDoc.");
  const last = captureState.lastCapture;
  $("capture-file").hidden = !last;
  $("capture-file").textContent = last ? "Last saved: " + last.path : "";
}
async function refreshCapture() {
  if (captureBusy || capturePoll) return;
  capturePoll = true;
  try {
    const fresh = await api("/api/capture");
    if (!captureBusy) { captureState = fresh; captureReceivedAt = Date.now(); paintCapture(); }
  } finally { capturePoll = false; }
}
async function captureAction(action) {
  if (captureBusy || !online) return;
  captureBusy = true; paintCapture();
  try {
    captureState = await api("/api/capture/" + action, { method: "POST", body: "{}" });
    captureReceivedAt = Date.now();
    if (action === "start") { $("capture").close(); notify("Recording started · Tap Stop to save"); }
    else notify(action === "screenshot" ? "Screenshot saved in Pictures / MacDoc" : "Recording saved in Videos / MacDoc");
  } catch (error) { report(error); }
  finally { captureBusy = false; paintCapture(); }
}
function openCapture() {
  $("drawer").close(); paintCapture();
  if (!$("capture").open) $("capture").showModal();
  refreshCapture().catch(report);
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
  });
  if (res.status === 401 && path !== "/api/auth") { showPair("Enter the current PIN to reconnect."); throw new Error("unauthorized"); }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).error;
    const messages = { "wrong pin": "That PIN doesn’t match. Try the PIN shown on your Mac.", "invalid pin": "Enter all four digits.", locked: "Too many attempts. Wait a moment and try again.", "internal error": "Your Mac couldn’t complete that action. Check the app or device and try again." };
    throw Object.assign(new Error(messages[detail] || detail || "The request couldn’t be completed."), { status: res.status });
  }
  return res.json();
}
function showPair(message = "") {
  document.body.classList.remove("is-paired"); panels?.close(true);
  welcome.sync(state, false);
  paired = false;
  paintCapture();
  syncLayout();
  clearTimeout(reconnectTimer);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("pair").hidden = false;
  $("app").hidden = true;
  $("pair-error").textContent = message;
}
function showApp() { paired = true; document.body.classList.add("is-paired"); $("pair").hidden = true; $("app").hidden = false; syncLayout(); paintCapture(); showPairingInfo(); }
// Only the host's own browser is given the PIN; other devices get 403 and see nothing.
async function showPairingInfo() {
  try {
    const res = await fetch("/api/pairing", { credentials: "same-origin" });
    if (!res.ok) return;
    const { pin, address } = await res.json();
    document.querySelectorAll("[data-pair-pin]").forEach((el) => { el.textContent = pin; });
    document.querySelectorAll("[data-pair-address]").forEach((el) => { el.textContent = address ? "Mac address · " + address.replace(/^https?:\/\//, "") : ""; });
    document.querySelectorAll("[data-pair-info]").forEach((el) => { el.hidden = false; });
  } catch { /* pairing details are optional */ }
}
function setConn(on) {
  online = on;
  if (!on) inputPad.disconnect();
  $("conn").dataset.state = on ? "on" : "off";
  $("conn").textContent = on ? "Connected" : paired ? "Reconnecting" : "Connecting";
  $("drawer-conn").dataset.state = $("conn").dataset.state;
  $("drawer-conn").textContent = $("conn").textContent;
  paintCapture();
}
function syncLayout() {
  const root = document.documentElement.style;
  root.setProperty("--columns", layout.columns);
  root.setProperty("--rows", layout.rows);
  root.setProperty("--icon-size", (layout.immersive ? layout.iconSize : 72) + "px");
  root.setProperty("--icon-scale", GRIDS[layout.perPage].scale);
  document.documentElement.dataset.background = layout.background;
  document.documentElement.dataset.theme = layout.theme;
  document.body.classList.toggle("is-immersive", layout.immersive);
  document.body.classList.toggle("show-labels", layout.showLabels);
  $("drawer-open").hidden = !layout.immersive || !paired;
  $("edit-done").hidden = !layout.immersive || !editing || !paired;
  $("immersive").checked = layout.immersive;
  $("show-labels").checked = layout.showLabels;
  $("show-labels").disabled = !layout.immersive;
  $("glass-theme").value = layout.theme;
  $("layout-summary").textContent = layout.perPage + " icons · " + layout.columns + " × " + layout.rows;
  document.querySelectorAll("[data-per-page]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.perPage) === layout.perPage)));
  document.querySelectorAll("[data-background]").forEach((button) => { if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(button.dataset.background === layout.background)); });
}
// Layout and side-page settings are shared through the host, so the setup
// page on the Mac and every paired device show the same dock.
let appliedSettingsAt = 0, settingsPush = null;
const SHARED_LAYOUT_KEYS = ["perPage", "background", "theme", "showLabels", "immersive"];
function saveLayout(changes, { fromHost = false } = {}) {
  layout = normalizeLayout({ ...layout, ...changes });
  try { localStorage.setItem("macdoc-layout", JSON.stringify(layout)); } catch { /* Device preferences are optional. */ }
  currentPage = 0; syncLayout(); paint();
  if (fromHost || !paired) return;
  pushLayout();
}
function pushLayout() {
  clearTimeout(settingsPush);
  settingsPush = setTimeout(async () => {
    try {
      const body = Object.fromEntries(SHARED_LAYOUT_KEYS.map((key) => [key, layout[key]]));
      const { settings } = await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
      appliedSettingsAt = settings?.updatedAt || appliedSettingsAt;
    } catch { /* The host may be older; this device keeps its own layout. */ }
  }, 300);
}
let seededHost = false;
function applyHostSettings(settings) {
  // The first device to connect shares its own layout, so the setup page starts from what the tablet shows.
  if (!settings) { if (paired && !seededHost) { seededHost = true; pushLayout(); } return false; }
  if (settings.updatedAt <= appliedSettingsAt) return false;
  appliedSettingsAt = settings.updatedAt;
  panels.configure(settings);
  const changed = SHARED_LAYOUT_KEYS.some((key) => settings[key] !== layout[key]);
  if (changed) saveLayout(Object.fromEntries(SHARED_LAYOUT_KEYS.map((key) => [key, settings[key]])), { fromHost: true });
  return changed;
}
function showPageHint() {
  clearTimeout(pageHintTimer);
  $("page-dots").classList.add("is-awake");
  pageHintTimer = setTimeout(() => $("page-dots").classList.remove("is-awake"), 1300);
}
function paint() {
  const running = new Set(state.running.map((app) => app.id));
  const view = { ...state, tiles: state.tiles.map((tile) => tile.kind === "app" ? { ...tile, running: running.has(tile.id) } : tile) };
  const pages = pageCount(state.tiles, layout);
  currentPage = Math.min(currentPage, pages - 1);
  if (applyHostSettings(state.settings)) return; // saveLayout repaints with the new grid
  welcome.sync(state, paired);
  $("dock").innerHTML = renderPages(view, layout, editing);
  $("dock").classList.toggle("is-editing", editing);
  $("dock").scrollTo({ left: currentPage * $("dock").clientWidth, behavior: "instant" });
  $("host-name").textContent = state.hostName || state.platformName || "Your Mac";
  $("drawer-host").textContent = $("host-name").textContent;
  document.body.classList.toggle("is-arranging", editing);
  $("edit-done").hidden = !layout.immersive || !editing || !paired;
  $("drawer-edit").innerHTML = icon(editing ? "check" : "edit") + "<span>" + (editing ? "Done" : "Arrange") + "</span>";
  $("dock-title").textContent = editing ? "A place for everything." : "Make yourself at home.";
  $("edit-hint").textContent = editing ? "Drag to move · Tap an icon for options · Done to finish" : "Hold an icon to arrange your space";
  $("edit").setAttribute("aria-pressed", String(editing));
  $("edit").setAttribute("aria-label", editing ? "Done editing" : "Edit dock");
  $("edit").innerHTML = icon(editing ? "check" : "edit") + "<span>" + (editing ? "Done" : "Edit") + "</span>";
  $("page-dots").innerHTML = Array.from({ length: pages }, (_, i) => '<button class="page-dot" type="button" data-page="' + i + '" aria-label="Go to page ' + (i + 1) + '"' + (i === currentPage ? ' aria-current="page"' : "") + '></button>').join("");
}
function pageTo(page, smooth = true) {
  currentPage = Math.max(0, Math.min(pageCount(state.tiles, layout) - 1, page));
  $("dock").scrollTo({ left: currentPage * $("dock").clientWidth, behavior: smooth ? "smooth" : "instant" });
  if (smooth) showPageHint();
}
function enterEditing() { if (saving) return; editing = true; paint(); }
async function commitTiles(tiles, previous = state.tiles) {
  if (saving) throw new Error("Wait for your last change to finish.");
  saving = true;
  state = { ...state, tiles };
  paint();
  try {
    const saved = await api("/api/tiles", { method: "PUT", body: JSON.stringify({ tiles: toWireTiles(tiles) }) });
    state = { ...state, tiles: saved.tiles };
    paint();
  } catch (err) { state = { ...state, tiles: previous }; paint(); throw err; }
  finally { saving = false; }
}
function connect() {
  if (!paired || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(scheme + "//" + location.host);
  socket = ws;
  ws.onopen = () => setConn(true);
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setConn(false);
    if (paired) reconnectTimer = setTimeout(async () => {
      try { await refresh(); connect(); } catch (error) { if (paired) reconnectTimer = setTimeout(connect, 2000); }
    }, 2000);
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type !== "snapshot") return;
      state = { ...msg, tiles: editing || saving || gesture?.dragging ? state.tiles : msg.tiles };
      if (!gesture?.dragging) paint();
    } catch { /* Ignore malformed frames. */ }
  };
}
async function refresh() {
  const fresh = await api("/api/state");
  state = { ...fresh, tiles: editing || saving || gesture?.dragging ? state.tiles : fresh.tiles };
  if (!gesture?.dragging) paint();
  await nowPlaying.refresh().catch(() => {});
  await refreshCapture().catch(() => {});
}
const powerActions = {
  lock: ["Lock your Mac?", "Your computer will return to its lock screen.", "Lock Mac"],
  sleep: ["Put your Mac to sleep?", "MacDoc will disconnect until you wake your computer.", "Sleep"],
  restart: ["Restart your Mac?", "Save your work first. MacDoc will disconnect while your computer restarts.", "Restart"],
  shutdown: ["Shut down your Mac?", "Save your work first. You’ll need to turn your computer back on to reconnect.", "Shut down"],
};
function confirmPower(verb) {
  return new Promise((resolve) => {
    const [title, description, label] = powerActions[verb];
    $("confirm-title").textContent = title;
    $("confirm-description").textContent = description;
    $("confirm-go").textContent = label;
    const dialog = $("confirm");
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
    dialog.showModal();
  });
}
async function activate(button) {
  if (editing && button.dataset.tileKey) return openTileOptions(button.dataset.tileKey);
  if (!online) return notify("Your Mac is disconnected. Wait for it to reconnect.", true);
  const { action, key } = button.dataset;
  if (action === "control" && powerActions[key] && !await confirmPower(key)) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (action === "control") {
      const raw = button.dataset.value;
      await api("/api/control", { method: "POST", body: JSON.stringify(raw === undefined ? { verb: key } : { verb: key, value: Number(raw) }) });
      if (key.startsWith("media-")) nowPlaying.refresh().catch(() => {});
      notify(powerActions[key] ? "Command sent to your Mac" : "Control sent");
    } else if (action === "launch") {
      const running = state.running.find((item) => item.id === key);
      const title = state.tiles.find((item) => item.id === key)?.label || "App";
      await api(running ? "/api/apps/focus" : "/api/apps/launch", { method: "POST", body: JSON.stringify(running ? { pid: running.pid } : { id: key }) });
      notify((running ? "Brought forward: " : "Opened: ") + title);
    }
  } catch (error) { report(error); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}
function openTileOptions(key) {
  selectedKey = key;
  const index = state.tiles.findIndex((tile) => tileKey(tile) === key);
  const tile = state.tiles[index];
  if (!tile) return;
  $("tile-options-title").textContent = tile.label;
  $("tile-options-icon").innerHTML = tile.kind === "app" ? renderAppIcon(tile) : controlIcon(tile.verb);
  $("tile-earlier").disabled = index === 0;
  $("tile-later").disabled = index === state.tiles.length - 1;
  $("tile-options").showModal();
}
function drawApps() {
  const term = $("filter").value.trim().toLowerCase();
  const matches = installedApps.filter((app) => app.name.toLowerCase().includes(term));
  const pinned = new Set(state.tiles.filter((tile) => tile.kind === "app").map((tile) => tile.id));
  $("picker-status").textContent = matches.length + " apps" + (term ? " found" : " on your Mac") + " · " + pinned.size + " pinned";
  $("picker-list").innerHTML = matches.length ? matches.map((app) => '<li><button type="button" data-id="' + escapeHtml(app.id) + '"' + (pinned.has(app.id) ? " disabled" : "") + ' aria-label="' + escapeHtml((pinned.has(app.id) ? "Pinned: " : "Add ") + app.name) + '">' + renderAppIcon(app, true) + '<span class="picker__name">' + escapeHtml(app.name) + '<small>' + (pinned.has(app.id) ? "On your dock" : (state.platformName || "Desktop") + " app") + '</small></span><span class="picker__add">' + icon(pinned.has(app.id) ? "check" : "plus") + "</span></button></li>").join("") : '<li class="picker__empty">No apps found. Try a different name.</li>';
}
function drawControls() {
  const groups = availableControls(state.verbs, state.tiles);
  $("control-list").innerHTML = renderControlPicker(groups);
  $("picker-status").textContent = "Pin the controls you reach for most";
}
function selectTab(which) {
  const apps = which === "apps";
  for (const [id, active] of [["tab-apps", apps], ["tab-controls", !apps]]) {
    $(id).classList.toggle("is-active", active);
    $(id).setAttribute("aria-selected", String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  $("picker-list").hidden = !apps;
  $("control-list").hidden = apps;
  $("picker-search").hidden = !apps;
  if (apps && appsLoaded) drawApps(); else if (!apps) drawControls();
}
async function openPicker() {
  selectTab("apps");
  if (!$("picker").open) $("picker").showModal();
  if (appsLoaded) drawApps();
  else { $("picker-status").textContent = "Loading your apps…"; $("picker-list").innerHTML = '<li class="picker__empty">Finding your favorites on this Mac…</li>'; }
  try {
    const { apps } = await api("/api/apps/installed");
    installedApps = apps; appsLoaded = true;
    if ($("tab-apps").getAttribute("aria-selected") === "true") drawApps();
  } catch (error) { $("picker-status").textContent = "Couldn’t load apps. Close the library and try again."; report(error); }
}
function openSettings() { $("drawer").close(); panels.close(true); syncLayout(); renderPagesList(); if (!$("settings").open) $("settings").showModal(); }
function openDrawer() { if (paired && !$("drawer").open) { $("drawer").showModal(); startStats(); } }
let statsTimer = null;
function formatStats(stats) {
  const parts = [];
  if (Number.isFinite(stats?.cpu)) parts.push("CPU " + stats.cpu + "%");
  if (Number.isFinite(stats?.memory)) parts.push("Memory " + stats.memory + "%");
  if (Number.isFinite(stats?.battery)) parts.push("Battery " + stats.battery + "%" + (stats.charging ? " ⚡" : ""));
  return parts.join(" · ");
}
async function refreshStats() {
  try { const text = formatStats(await api("/api/stats")); $("drawer-stats").textContent = text; $("drawer-stats").hidden = !text; }
  catch { $("drawer-stats").hidden = true; }
}
function startStats() { clearInterval(statsTimer); refreshStats(); statsTimer = setInterval(refreshStats, 5000); }

$("picker-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button || button.disabled || saving) return;
  const app = installedApps.find((item) => item.id === button.dataset.id);
  if (!app) return;
  if (state.tiles.length >= 64) return notify("Your dock is full. Remove a tile before adding another.", true);
  button.disabled = true;
  try {
    await commitTiles(addAppTile(state.tiles, app));
    drawApps();
    notify(app.name + " added to your dock");
  } catch (error) { report(error); button.disabled = false; }
});
$("control-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-verb]");
  if (!button || button.disabled || saving) return;
  if (state.tiles.length >= 64) return notify("Your dock is full. Remove a tile before adding another.", true);
  const value = button.dataset.value === undefined ? null : Number(button.dataset.value);
  const item = availableControls(state.verbs, state.tiles).flatMap((group) => group.items).find((item) => item.verb === button.dataset.verb && (item.value ?? null) === value);
  button.disabled = true;
  try { await commitTiles(addControlTile(state.tiles, item.verb, item.label, value)); drawControls(); notify(item.label + " added to your dock"); }
  catch (error) { report(error); button.disabled = false; }
});

// Pointer gestures share stable tile keys. Only the final drop is persisted;
// canceled gestures restore their original order and send no mutation.
let gesture = null, dragGhost = null, edgeTimer = null;
function cleanupGesture(cancel = false) {
  if (!gesture) return;
  clearTimeout(gesture.holdTimer); clearTimeout(edgeTimer); edgeTimer = null;
  if (cancel && gesture.dragging) { state = { ...state, tiles: gesture.previous }; paint(); }
  dragGhost?.remove(); dragGhost = null;
  $("dock").querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  gesture = null;
}
$("dock").addEventListener("contextmenu", (event) => event.preventDefault());
$("dock").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || saving || !event.isPrimary) return;
  const tile = event.target.closest("[data-tile-key]");
  gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, key: tile?.dataset.tileKey, previous: state.tiles, page: currentPage, dragging: false, held: false, wasEditing: editing };
  if (state.tiles.length && !editing) gesture.holdTimer = setTimeout(() => {
    if (!gesture) return;
    gesture.held = true; suppressClickUntil = Date.now() + 600;
    enterEditing(); navigator.vibrate?.(18);
  }, 450);
});
$("dock").addEventListener("touchmove", (event) => {
  if (editing && gesture?.key) event.preventDefault();
}, { passive: false });
document.addEventListener("pointermove", (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  if (!editing) {
    if (Math.hypot(dx, dy) > 10) clearTimeout(gesture.holdTimer);
    return;
  }
  if (!gesture.key || Math.hypot(dx, dy) < 9 && !gesture.dragging) return;
  event.preventDefault();
  if (!gesture.dragging) {
    gesture.dragging = true;
    const original = Array.from($("dock").querySelectorAll("[data-tile-key]")).find((el) => el.dataset.tileKey === gesture.key);
    if (!original) return cleanupGesture(true);
    const bounds = original.getBoundingClientRect();
    dragGhost = original.cloneNode(true);
    dragGhost.classList.add("drag-ghost"); dragGhost.classList.remove("is-editing");
    dragGhost.style.width = bounds.width + "px"; dragGhost.style.height = bounds.height + "px";
    dragGhost.setAttribute("aria-hidden", "true");
    document.body.append(dragGhost);
  }
  dragGhost.style.left = event.clientX + "px"; dragGhost.style.top = event.clientY + "px";
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-tile-key]");
  if (target && target.dataset.tileKey !== gesture.key) {
    state = { ...state, tiles: moveToTile(state.tiles, gesture.key, target.dataset.tileKey) };
    paint();
  }
  $("dock").querySelectorAll("[data-tile-key]").forEach((el) => el.classList.toggle("is-dragging", el.dataset.tileKey === gesture.key));
  const bounds = $("dock").getBoundingClientRect();
  const direction = event.clientX < bounds.left + 40 ? -1 : event.clientX > bounds.right - 40 ? 1 : 0;
  if (!direction) { clearTimeout(edgeTimer); edgeTimer = null; }
  else if (!edgeTimer) edgeTimer = setTimeout(() => {
    edgeTimer = null;
    if (!gesture?.dragging) return;
    const page = Math.max(0, Math.min(pageCount(state.tiles, layout) - 1, currentPage + direction));
    if (page === currentPage) return;
    const capacity = layout.columns * layout.rows;
    const targetIndex = Math.min(state.tiles.length - 1, page * capacity + (direction < 0 ? capacity - 1 : 0));
    state = { ...state, tiles: moveToTile(state.tiles, gesture.key, tileKey(state.tiles[targetIndex])) };
    currentPage = page; paint();
  }, 550);
}, { passive: false });
document.addEventListener("pointerup", (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const previous = gesture.previous, dragged = gesture.dragging;
  const startPage = gesture.page;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  const swipeUp = !dragged && !gesture.held && dy < -55 && Math.abs(dy) > Math.abs(dx) * 1.3;
  const swipeAcross = !dragged && !gesture.held && !editing && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3;
  if (dragged || gesture.held || Math.hypot(dx, dy) > 15) suppressClickUntil = Date.now() + 500;
  cleanupGesture();
  if (dragged) commitTiles(state.tiles, previous).catch(report);
  else if (swipeUp) openDrawer();
  else if (swipeAcross) pageTo(startPage + (dx < 0 ? 1 : -1));
});
document.addEventListener("pointercancel", () => cleanupGesture(true));
window.addEventListener("blur", () => cleanupGesture(true));
let footerGesture;
$("gesture-area").addEventListener("pointerdown", (event) => { footerGesture = { x: event.clientX, y: event.clientY }; });
$("gesture-area").addEventListener("pointerup", (event) => {
  if (footerGesture && footerGesture.y - event.clientY > 35 && Math.abs(event.clientX - footerGesture.x) < 70) { suppressClickUntil = Date.now() + 500; openDrawer(); }
  footerGesture = null;
});
$("dock").addEventListener("scroll", () => {
  if (!$("dock").clientWidth) return;
  currentPage = Math.round($("dock").scrollLeft / $("dock").clientWidth);
  showPageHint();
  $("page-dots").querySelectorAll("[data-page]").forEach((button) => {
    if (Number(button.dataset.page) === currentPage) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}, { passive: true });
$("page-dots").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) pageTo(Number(button.dataset.page));
});
window.addEventListener("resize", () => { syncLayout(); requestAnimationFrame(() => pageTo(currentPage, false)); });
document.addEventListener("click", (event) => {
  // A gesture can open a dialog before the browser emits its follow-up click.
  // Suppress that click globally, even when it is retargeted to the new dialog.
  if (Date.now() < suppressClickUntil && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  const close = event.target.closest("[data-close]");
  if (close) $(close.dataset.close).close();
  if (event.target.closest("[data-open-picker]")) openPicker();
  const button = event.target.closest("button[data-action]");
  if (button) activate(button).catch(report);
}, true);
function toggleEditing() { if (!saving) { editing = !editing; paint(); } }
$("edit").addEventListener("click", toggleEditing);
$("edit-done").addEventListener("click", toggleEditing);
$("drawer-edit").addEventListener("click", () => { $("drawer").close(); toggleEditing(); });
for (const [id, delta] of [["tile-earlier", -1], ["tile-later", 1], ["tile-remove", 0]]) {
  $(id).addEventListener("click", async () => {
    $("tile-options").close();
    try { await commitTiles(delta ? moveTile(state.tiles, selectedKey, delta) : removeTile(state.tiles, selectedKey)); notify(delta ? "Position updated" : "Removed from your dock"); }
    catch (error) { report(error); }
  });
}
$("add").addEventListener("click", openPicker);
$("picker-close").addEventListener("click", () => $("picker").close());
$("tab-apps").addEventListener("click", () => selectTab("apps"));
$("tab-controls").addEventListener("click", () => selectTab("controls"));
document.querySelector(".picker__tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const apps = event.key === "Home" || event.key !== "End" && $("tab-apps").getAttribute("aria-selected") !== "true";
  selectTab(apps ? "apps" : "controls"); $(apps ? "tab-apps" : "tab-controls").focus();
});
$("filter").addEventListener("input", drawApps);
$("settings-open").addEventListener("click", openSettings);
$("swipe-settings").addEventListener("click", openDrawer);
$("controls-open").addEventListener("click", () => { $("controls-grid").innerHTML = renderControls(state.verbs, state.allowDestructive); $("controls").showModal(); });
document.querySelectorAll("button[data-per-page]").forEach((button) => button.addEventListener("click", () => saveLayout({ perPage: Number(button.dataset.perPage) })));
document.querySelectorAll("button[data-background]").forEach((button) => button.addEventListener("click", () => saveLayout({ background: button.dataset.background })));
$("immersive").addEventListener("change", () => saveLayout({ immersive: $("immersive").checked }));
$("show-labels").addEventListener("change", () => saveLayout({ showLabels: $("show-labels").checked }));
$("glass-theme").addEventListener("change", () => saveLayout({ theme: $("glass-theme").value }));
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    if (!document.documentElement.requestFullscreen) return notify("Use your browser’s fullscreen option, then turn your phone sideways.");
    await document.documentElement.requestFullscreen();
    await screen.orientation?.lock?.("landscape").catch(() => {});
    $("settings").close();
    $("drawer").close();
  } catch { notify("Fullscreen isn’t available here. Turn your phone sideways to continue."); }
}
$("fullscreen").addEventListener("click", toggleFullscreen);
$("drawer-fullscreen").addEventListener("click", toggleFullscreen);
$("drawer-open").addEventListener("click", openDrawer);
$("drawer-close").addEventListener("click", () => $("drawer").close());
$("drawer-settings").addEventListener("click", openSettings);
$("drawer-apps").addEventListener("click", () => { $("drawer").close(); openPicker(); });
$("drawer-controls").addEventListener("click", () => { $("drawer").close(); $("controls-grid").innerHTML = renderControls(state.verbs, state.allowDestructive); $("controls").showModal(); });
$("drawer-capture").addEventListener("click", openCapture);
const clipboardSheet = createClipboardSheet({ api, notify, hostName: () => state.hostName || "your computer" });
const panels = createPanels({ api, notify, report, clipboard: clipboardSheet, isReady: () => paired && !document.body.classList.contains("has-welcome") });
$("drawer-clipboard").addEventListener("click", () => { $("drawer").close(); panels.open("mixer"); });
$("dock-gear").addEventListener("click", openSettings);
$("pages-arrange").addEventListener("click", () => { $("settings").close(); if (!editing) toggleEditing(); });
$("pages-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-page-move]");
  if (!button || saving) return;
  const capacity = layout.columns * layout.rows;
  const moved = movePage(state.tiles, Number(button.dataset.page), Number(button.dataset.pageMove), capacity);
  if (!moved) return;
  try { await commitTiles(moved); currentPage = Number(button.dataset.page) + Number(button.dataset.pageMove); renderPagesList(); paint(); }
  catch (error) { report(error); }
});
function renderPagesList() {
  const capacity = layout.columns * layout.rows;
  const pages = pageCount(state.tiles, layout);
  const full = (index) => (index + 1) * capacity <= state.tiles.length;
  $("pages-list").innerHTML = state.tiles.length ? Array.from({ length: pages }, (_, index) => {
    const tiles = state.tiles.slice(index * capacity, (index + 1) * capacity);
    const strip = tiles.slice(0, 10).map((tile) => tile.kind === "app" ? renderAppIcon(tile) : '<span class="pages__control">' + controlIcon(tile.verb) + "</span>").join("");
    const canMove = (delta) => full(index) && index + delta >= 0 && index + delta < pages && full(index + delta);
    return '<li><span class="pages__name">Page ' + (index + 1) + "<small>" + tiles.length + " of " + capacity + "</small></span><span class=\"pages__strip\">" + strip + "</span>" +
      '<span class="pages__moves"><button type="button" class="icon-button" data-page="' + index + '" data-page-move="-1" aria-label="Move page ' + (index + 1) + ' left"' + (canMove(-1) ? "" : " disabled") + ">" + icon("left") + "</button>" +
      '<button type="button" class="icon-button" data-page="' + index + '" data-page-move="1" aria-label="Move page ' + (index + 1) + ' right"' + (canMove(1) ? "" : " disabled") + ">" + icon("right") + "</button></span></li>";
  }).join("") : '<li class="pages__empty">Add apps to your dock to see its pages here.</li>';
}
$("drawer").addEventListener("close", () => clearInterval(statsTimer));
const inputPad = createInputPad({ api, notify, WebSocketClass: WebSocket, storage: localStorage });
$("drawer-input").addEventListener("click", () => inputPad.open());
$("capture-screenshot").addEventListener("click", () => captureAction("screenshot"));
$("capture-record").addEventListener("click", () => captureAction(captureActive() ? "stop" : "start"));
$("recording-stop").addEventListener("click", () => captureAction("stop"));
setInterval(() => { if (paired && !document.hidden) refreshCapture().catch(() => {}); }, 2000);
setInterval(() => { if (paired && captureActive() && !document.hidden) paintCapture(); }, 500);
// The invisible lower edge is also a keyboard-accessible button. Track swipes
// at document level so lifting above the original hit area still opens it.
let edgeGesture = null;
$("drawer-open").addEventListener("pointerdown", (event) => { edgeGesture = { id: event.pointerId, y: event.clientY }; });
document.addEventListener("pointerup", (event) => {
  if (edgeGesture?.id === event.pointerId && edgeGesture.y - event.clientY > 25) { suppressClickUntil = Date.now() + 500; openDrawer(); }
  edgeGesture = null;
});
document.addEventListener("pointercancel", () => { edgeGesture = null; });
let drawerGesture = null;
$("drawer-close").addEventListener("pointerdown", (event) => { drawerGesture = { id: event.pointerId, y: event.clientY }; });
document.addEventListener("pointerup", (event) => {
  if (drawerGesture?.id === event.pointerId && event.clientY - drawerGesture.y > 30) { suppressClickUntil = Date.now() + 500; $("drawer").close(); }
  drawerGesture = null;
});
$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  try { appsLoaded = false; await refresh(); connect(); notify("Your dock is up to date"); } catch (error) { report(error); }
  finally { $("refresh").disabled = false; }
});
$("confirm-cancel").addEventListener("click", () => $("confirm").close("no"));
$("confirm-go").addEventListener("click", () => $("confirm").close("yes"));
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/auth", { method: "POST", body: JSON.stringify({ pin: $("pin").value }) });
    showApp(); await refresh(); connect();
  } catch (error) { showPair(error.message); } finally { button.disabled = false; }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* The shell also works without a service worker. */ });
}
syncLayout();
(async function boot() {
  try { await refresh(); showApp(); connect(); }
  catch (error) { showPair(error.message === "unauthorized" ? "" : "Start MacDoc on your Mac, then connect with its PIN."); }
})();
// Refresh when returning to the dock. No background native polling while hidden.
document.addEventListener("visibilitychange", () => { if (!document.hidden && paired) refresh().then(connect).catch(report); });
