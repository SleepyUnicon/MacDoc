import { renderAppIcon, renderCustomIcon, escapeHtml } from "./dock.js";
import { icon, controlIcon } from "./icons.js";
import { addAppTile, addControlTile, removeTile, toWireTiles, availableControls, tileKey } from "./tiles.js";

const $ = (id) => document.getElementById(id);
const GRID_SIZES = { 4: [2, 2], 6: [3, 2], 8: [4, 2], 12: [4, 3], 15: [5, 3], 18: [6, 3], 21: [7, 3], 24: [6, 4], 28: [7, 4], 32: [8, 4] };
const BACKGROUNDS = [["aurora", "Aurora"], ["dusk", "Dusk"], ["ember", "Ember"], ["midnight", "Midnight"]];
const PANELS = [["player", "Music player", "Artwork, progress and playback for whatever is playing."], ["mixer", "Clipboard & sound", "The shared clipboard and each app's volume."], ["none", "Nothing", "Turn this edge off."]];
const DEFAULTS = { perPage: 4, background: "aurora", theme: "glass", showLabels: false, immersive: true, leftPanel: "player", rightPanel: "mixer", showClipboard: true, showSound: true };

let state = { tiles: [], verbs: [], hostName: "" };
let settings = { ...DEFAULTS };
let apps = [], libTab = "apps", saving = false, iconTarget = null, dragKey = null;

// ---------- plumbing ----------
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: options.body ? { "content-type": "application/json" } : {}, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || "That didn't work. Try again."), { status: res.status });
  return body;
}
let toastTimer;
function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("is-error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2600);
}
const report = (error) => toast(error.message, true);
document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });

// ---------- dock ----------
const capacity = () => settings.perPage || 4;
function tileIcon(tile) {
  if (tile.customIcon) return renderCustomIcon(tile.customIcon);
  return tile.kind === "app" ? renderAppIcon(tile) : '<span class="control-glyph">' + controlIcon(tile.verb) + "</span>";
}
function paintDock() {
  const tiles = state.tiles;
  const size = capacity();
  const [columns] = GRID_SIZES[size] || [4];
  $("dock-count").textContent = tiles.length + (tiles.length === 1 ? " tile" : " tiles") + " · " + Math.max(1, Math.ceil(tiles.length / size)) + " pages";
  if (!tiles.length) {
    $("dock-pages").innerHTML = '<div class="empty">Your dock is empty. Add apps from the list on the right.</div>';
    return;
  }
  const pages = [];
  for (let start = 0; start < tiles.length; start += size) pages.push(tiles.slice(start, start + size));
  $("dock-pages").innerHTML = pages.map((page, index) => '<div class="page"><div class="page__label">Page ' + (index + 1) + "</div>" +
    '<ol class="page__grid" style="--columns:' + columns + '">' + page.map((tile) => {
      const key = tileKey(tile);
      return '<li class="tile" draggable="true" data-key="' + escapeHtml(key) + '">' +
        '<button class="tile__icon" type="button" data-icon-for="' + escapeHtml(key) + '" title="Change icon" aria-label="Change the icon for ' + escapeHtml(tile.label) + '">' + tileIcon(tile) + '<span class="tile__edit">' + icon("edit") + "</span></button>" +
        '<input class="tile__name" value="' + escapeHtml(tile.label) + '" data-label-for="' + escapeHtml(key) + '" maxlength="60" aria-label="Name">' +
        '<div class="tile__actions">' +
        (tile.customIcon ? '<button type="button" data-reset-icon="' + escapeHtml(key) + '" title="Use the original icon">Reset icon</button>' : "") +
        '<button type="button" data-remove="' + escapeHtml(key) + '" title="Remove from dock" aria-label="Remove ' + escapeHtml(tile.label) + '">' + icon("trash") + "</button></div></li>";
    }).join("") + "</ol></div>").join("");
}

async function saveTiles(tiles, message) {
  if (saving) return toast("Wait for the last change to finish.", true);
  saving = true;
  const previous = state.tiles;
  state = { ...state, tiles };
  paintDock(); paintLibrary();
  try {
    const saved = await api("/api/tiles", { method: "PUT", body: JSON.stringify({ tiles: toWireTiles(tiles) }) });
    state = { ...state, tiles: saved.tiles };
    paintDock(); paintLibrary();
    if (message) toast(message);
  } catch (error) {
    state = { ...state, tiles: previous };
    paintDock(); paintLibrary();
    report(error);
  } finally { saving = false; }
}
const updateTile = (key, change) => state.tiles.map((tile) => tileKey(tile) === key ? { ...tile, ...change } : tile);

$("dock-pages").addEventListener("click", (event) => {
  const iconButton = event.target.closest("[data-icon-for]");
  if (iconButton) { iconTarget = iconButton.dataset.iconFor; $("icon-file").value = ""; $("icon-file").click(); return; }
  const reset = event.target.closest("[data-reset-icon]");
  if (reset) {
    const key = reset.dataset.resetIcon;
    saveTiles(state.tiles.map((tile) => { if (tileKey(tile) !== key) return tile; const { customIcon, ...rest } = tile; return rest; }), "Original icon restored");
    return;
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) saveTiles(removeTile(state.tiles, remove.dataset.remove), "Removed from your dock");
});
$("dock-pages").addEventListener("change", (event) => {
  const input = event.target.closest("[data-label-for]");
  const label = input?.value.trim();
  if (!input) return;
  if (!label) { paintDock(); return toast("A tile needs a name.", true); }
  saveTiles(updateTile(input.dataset.labelFor, { label }), "Renamed to " + label);
});
$("dock-pages").addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.matches("[data-label-for]")) event.target.blur(); });

// Drag to reorder: drop a tile onto another to take its place.
$("dock-pages").addEventListener("dragstart", (event) => {
  const tile = event.target.closest(".tile");
  if (!tile || event.target.matches("input")) return;
  dragKey = tile.dataset.key;
  tile.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragKey);
});
$("dock-pages").addEventListener("dragend", () => { dragKey = null; document.querySelectorAll(".is-dragging, .is-target").forEach((el) => el.classList.remove("is-dragging", "is-target")); });
$("dock-pages").addEventListener("dragover", (event) => {
  const tile = event.target.closest(".tile");
  if (!dragKey || !tile) return;
  event.preventDefault();
  document.querySelectorAll(".is-target").forEach((el) => el.classList.remove("is-target"));
  if (tile.dataset.key !== dragKey) tile.classList.add("is-target");
});
$("dock-pages").addEventListener("drop", (event) => {
  const tile = event.target.closest(".tile");
  if (!dragKey || !tile || tile.dataset.key === dragKey) return;
  event.preventDefault();
  const list = [...state.tiles];
  const from = list.findIndex((item) => tileKey(item) === dragKey);
  const to = list.findIndex((item) => tileKey(item) === tile.dataset.key);
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  saveTiles(list, "Moved");
});

// Custom icons are scaled to a 256px square PNG in the browser before upload.
$("icon-file").addEventListener("change", async () => {
  const file = $("icon-file").files[0];
  if (!file || !iconTarget) return;
  try {
    const url = URL.createObjectURL(file);
    const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("That file isn't an image this browser can open.")); img.src = url; });
    const canvas = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const scale = Math.min(256 / image.naturalWidth, 256 / image.naturalHeight) || 1;
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    canvas.getContext("2d").drawImage(image, (256 - w) / 2, (256 - h) / 2, w, h);
    URL.revokeObjectURL(url);
    const { icon: hash } = await api("/api/icons", { method: "POST", body: JSON.stringify({ data: canvas.toDataURL("image/png") }) });
    await saveTiles(updateTile(iconTarget, { customIcon: hash }), "New icon saved");
  } catch (error) { report(error); }
  finally { iconTarget = null; }
});

// ---------- library ----------
function paintLibrary() {
  const filter = $("lib-filter").value.trim().toLowerCase();
  $("lib-filter").hidden = libTab !== "apps";
  if (libTab === "apps") {
    const pinned = new Set(state.tiles.filter((tile) => tile.kind === "app").map((tile) => tile.id));
    const list = apps.filter((app) => !filter || app.name.toLowerCase().includes(filter));
    $("lib-list").innerHTML = list.length ? list.map((app) => '<li><button type="button" data-add-app="' + escapeHtml(app.id) + '"' + (pinned.has(app.id) ? " disabled" : "") + ">" + renderAppIcon(app, true) + "<span>" + escapeHtml(app.name) + "</span><em>" + (pinned.has(app.id) ? "On dock" : "Add") + "</em></button></li>").join("")
      : '<li class="empty">' + (apps.length ? "No apps match." : "Loading your apps…") + "</li>";
  } else {
    const groups = availableControls(state.verbs, state.tiles);
    $("lib-list").innerHTML = groups.map((group) => '<li class="lib-group">' + escapeHtml(group.group) + "</li>" + group.items.map((item) =>
      '<li><button type="button" data-add-control="' + escapeHtml(item.verb) + '" data-value="' + (item.value ?? "") + '" data-label="' + escapeHtml(item.label) + '"' + (item.pinned ? " disabled" : "") + '><span class="control-glyph">' + controlIcon(item.verb) + "</span><span>" + escapeHtml(item.label) + "</span><em>" + (item.pinned ? "On dock" : "Add") + "</em></button></li>").join("")).join("");
  }
}
for (const [id, tab] of [["lib-apps", "apps"], ["lib-controls", "controls"]]) $(id).addEventListener("click", () => {
  libTab = tab;
  $("lib-apps").classList.toggle("is-active", tab === "apps"); $("lib-apps").setAttribute("aria-selected", String(tab === "apps"));
  $("lib-controls").classList.toggle("is-active", tab === "controls"); $("lib-controls").setAttribute("aria-selected", String(tab === "controls"));
  paintLibrary();
});
$("lib-filter").addEventListener("input", paintLibrary);
$("lib-list").addEventListener("click", (event) => {
  const app = apps.find((item) => item.id === event.target.closest("[data-add-app]")?.dataset.addApp);
  if (app) return saveTiles(addAppTile(state.tiles, app), app.name + " added");
  const control = event.target.closest("[data-add-control]");
  if (control) saveTiles(addControlTile(state.tiles, control.dataset.addControl, control.dataset.label, control.dataset.value === "" ? null : Number(control.dataset.value)), control.dataset.label + " added");
});

// ---------- layout & side pages ----------
function paintSettings() {
  $("grid-choices").innerHTML = Object.entries(GRID_SIZES).map(([size, [columns]]) =>
    '<button type="button" data-grid="' + size + '" aria-pressed="' + (Number(size) === settings.perPage) + '"><span class="mini" style="--columns:' + columns + '">' + "<i></i>".repeat(Number(size)) + "</span><span>" + size + "</span></button>").join("");
  $("backgrounds").innerHTML = BACKGROUNDS.map(([value, name]) => '<button type="button" data-background="' + value + '" aria-pressed="' + (value === settings.background) + '"><span class="swatch swatch--' + value + '"></span>' + name + "</button>").join("");
  $("theme").value = settings.theme;
  $("show-labels").checked = settings.showLabels;
  $("immersive").checked = settings.immersive;
  for (const side of ["left", "right"]) {
    const current = settings[side + "Panel"];
    $(side + "-panel").innerHTML = PANELS.map(([value, name, hint]) => '<button type="button" role="radio" data-panel-side="' + side + '" data-panel="' + value + '" aria-checked="' + (value === current) + '"><strong>' + name + "</strong><span>" + hint + "</span></button>").join("");
  }
  $("show-clipboard").checked = settings.showClipboard;
  $("show-sound").checked = settings.showSound;
  paintDock();
}
let settingsTimer;
function saveSettings(change) {
  settings = { ...settings, ...change };
  paintSettings();
  $("layout-saved").textContent = "Saving…";
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    try { settings = { ...DEFAULTS, ...(await api("/api/settings", { method: "PUT", body: JSON.stringify(change) })).settings }; $("layout-saved").textContent = "Saved · on your tablet now"; }
    catch (error) { report(error); $("layout-saved").textContent = "Not saved"; }
  }, 150);
}
$("grid-choices").addEventListener("click", (event) => { const b = event.target.closest("[data-grid]"); if (b) saveSettings({ perPage: Number(b.dataset.grid) }); });
$("backgrounds").addEventListener("click", (event) => { const b = event.target.closest("[data-background]"); if (b) saveSettings({ background: b.dataset.background }); });
$("theme").addEventListener("change", () => saveSettings({ theme: $("theme").value }));
$("show-labels").addEventListener("change", () => saveSettings({ showLabels: $("show-labels").checked }));
$("immersive").addEventListener("change", () => saveSettings({ immersive: $("immersive").checked }));
for (const side of ["left", "right"]) $(side + "-panel").addEventListener("click", (event) => {
  const b = event.target.closest("[data-panel]");
  if (b) saveSettings({ [side + "Panel"]: b.dataset.panel });
});
for (const [id, key, other] of [["show-clipboard", "showClipboard", "show-sound"], ["show-sound", "showSound", "show-clipboard"]]) $(id).addEventListener("change", () => {
  if (!$(id).checked && !$(other).checked) { $(id).checked = true; return toast("Keep the clipboard or the sound column on.", true); }
  saveSettings({ [key]: $(id).checked });
});

// ---------- connection ----------
function ago(at) {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "just now";
  if (seconds < 5400) return Math.round(seconds / 60) + " min ago";
  if (seconds < 129600) return Math.round(seconds / 3600) + " h ago";
  return Math.round(seconds / 86400) + " days ago";
}
async function loadConnection() {
  try {
    const pairing = await api("/api/pairing");
    $("pin").textContent = pairing.pin;
    $("address").textContent = (pairing.address || location.origin).replace(/^https?:\/\//, "");
    const { devices } = await api("/api/devices");
    $("devices").innerHTML = devices.length ? devices.map((device) => '<li><div><strong>' + escapeHtml(device.name) + "</strong><span>" + escapeHtml(device.ip || "") + " · paired " + ago(device.created) + " · last seen " + ago(device.lastSeen) + '</span></div><button class="btn btn--ghost btn--small" type="button" data-signout="' + escapeHtml(device.id) + '">Sign out</button></li>').join("")
      : '<li class="empty">No devices paired yet. Open MacDoc on your tablet and enter the PIN.</li>';
  } catch (error) {
    if (error.status === 403) { $("connection-remote").hidden = false; $("connection-cards").hidden = true; }
    else report(error);
  }
}
$("pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = $("pin-input").value.trim();
  if (!/^\d{4}$/.test(pin)) return toast("Enter exactly 4 digits.", true);
  if (!confirm("Change the PIN to " + pin + "? Every paired device will need to enter it again.")) return;
  try { await api("/api/pin", { method: "POST", body: JSON.stringify({ pin }) }); $("pin-input").value = ""; toast("PIN changed. Enter " + pin + " on your tablet."); loadConnection(); }
  catch (error) { report(error); }
});
$("devices").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-signout]");
  if (!button) return;
  try { await api("/api/devices/" + encodeURIComponent(button.dataset.signout), { method: "DELETE" }); toast("Signed out. It will ask for the PIN next time."); loadConnection(); }
  catch (error) { report(error); }
});
$("signout-all").addEventListener("click", async () => {
  if (!confirm("Sign out every paired device?")) return;
  try { await api("/api/devices", { method: "DELETE" }); toast("All devices signed out."); loadConnection(); } catch (error) { report(error); }
});

// ---------- live state ----------
function applyState(next) {
  state = { ...state, ...next, tiles: saving ? state.tiles : next.tiles };
  if (next.settings) settings = { ...DEFAULTS, ...next.settings };
  $("host-line").textContent = (next.hostName || "Your Mac") + " · connected";
  if (!document.activeElement?.matches?.("[data-label-for], #pin-input")) paintSettings();
  paintLibrary();
}
function connect() {
  const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  socket.onmessage = (event) => { try { const message = JSON.parse(event.data); if (message.type === "snapshot") applyState(message); } catch { /* ignore */ } };
  socket.onclose = () => { $("host-line").textContent = "Reconnecting…"; setTimeout(connect, 2000); };
}
(async function boot() {
  try {
    applyState(await api("/api/state"));
    connect();
    api("/api/apps/installed").then(({ apps: list }) => { apps = list; paintLibrary(); }).catch(report);
    loadConnection();
    setInterval(loadConnection, 15000);
  } catch (error) {
    if (error.status === 401) { $("locked").hidden = false; document.querySelectorAll(".section").forEach((el) => { el.hidden = true; }); $("host-line").textContent = "Not paired"; }
    else report(error);
  }
})();
