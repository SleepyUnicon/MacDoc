import { icon } from "./icons.js";

/**
 * The frosted bar along the bottom of the home screen: Show Desktop on the
 * left, the Mac's volume in the middle, Lock and power options on the right.
 * Swiping up on it opens the drawer.
 */
export function createHomeBar({ api, notify, report, openDrawer, isOnline }) {
  const $ = (id) => document.getElementById(id);
  const bar = $("home-bar");
  let enabled = true, dragging = false, pushTimer = null, poll = null, muted = false;

  function paint(volume) {
    if (!volume || !Number.isFinite(volume.volume)) return;
    muted = volume.muted;
    if (!dragging) $("bar-slider").value = volume.volume;
    $("bar-volume-value").textContent = volume.muted ? "Muted" : volume.volume + "%";
    $("bar-slider").style.setProperty("--fill", (volume.muted ? 0 : volume.volume) + "%");
  }
  async function refresh() {
    if (!enabled || document.hidden || !isOnline()) return;
    try { paint(await api("/api/volume")); } catch { /* the next poll retries */ }
  }
  async function control(verb, value) {
    await api("/api/control", { method: "POST", body: JSON.stringify(value === undefined ? { verb } : { verb, value }) });
  }

  $("bar-slider").addEventListener("input", () => {
    dragging = true;
    const value = Number($("bar-slider").value);
    $("bar-volume-value").textContent = value + "%";
    $("bar-slider").style.setProperty("--fill", value + "%");
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => control("volume-set", value).catch(report), 90);
  });
  $("bar-slider").addEventListener("change", () => { dragging = false; setTimeout(refresh, 300); });
  for (const [id, verb] of [["bar-quieter", "volume-down"], ["bar-louder", "volume-up"]]) $(id).addEventListener("click", async () => {
    try { await control(verb); refresh(); } catch (error) { report(error); }
  });
  $("bar-desktop").addEventListener("click", async () => {
    try { const { state } = await api("/api/desktop", { method: "POST" }); notify(state === "restored" ? "Your windows are back" : "Showing the desktop"); }
    catch (error) { report(error); }
  });
  $("bar-lock").addEventListener("click", async () => {
    try { await control("lock"); notify("Your Mac is locked"); } catch (error) { report(error); }
  });

  // Power options pop up above the button; the menu items use the dock's own confirm-and-send path.
  const menu = $("power-menu");
  function showMenu(open) { menu.hidden = !open; $("bar-power").setAttribute("aria-expanded", String(open)); }
  $("bar-power").addEventListener("click", (event) => { event.stopPropagation(); showMenu(menu.hidden); });
  menu.addEventListener("click", () => showMenu(false));
  document.addEventListener("pointerdown", (event) => { if (!menu.hidden && !event.target.closest("#power-menu, #bar-power")) showMenu(false); });

  // Swipe up on the bar (or tap its grip) for the drawer.
  let start = null;
  bar.addEventListener("pointerdown", (event) => { if (!event.target.closest("button, input")) start = { id: event.pointerId, y: event.clientY }; });
  bar.addEventListener("pointerup", (event) => {
    if (start?.id !== event.pointerId) return;
    const dy = start.y - event.clientY;
    start = null;
    if (dy > 25 || event.target.closest(".home-bar__grip")) openDrawer();
  });

  bar.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  function configure(settings = {}) {
    enabled = settings.showBar !== false;
    bar.hidden = !enabled;
    document.body.classList.toggle("has-home-bar", enabled);
    clearInterval(poll);
    if (enabled) { refresh(); poll = setInterval(refresh, 5000); }
  }
  configure({});
  document.addEventListener("visibilitychange", refresh);
  return { configure, refresh };
}
