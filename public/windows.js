import { renderAppIcon, escapeHtml } from "./dock.js";

const POLL_MS = 3000;

/**
 * The window cards page: swipe down on the dock (or tap the handle at the top)
 * to see every window open on the Mac, then tap one to bring it to the front.
 * Swipe up, tap the empty space or the close button to go back.
 */
export function createWindowCards({ api, notify, report, isReady }) {
  const $ = (id) => document.getElementById(id);
  const page = $("windows-panel");
  let isOpen = false, timer = null, list = [], loadedAt = 0;

  function card(window) {
    const ratio = Math.max(0.45, Math.min(1.2, window.height / Math.max(1, window.width)));
    const preview = window.preview
      ? '<img class="win-card__shot" src="/api/windows/' + window.id + "/preview?t=" + loadedAt + '" alt="" draggable="false">'
      : '<span class="win-card__placeholder">' + renderAppIcon({ id: window.appId, name: window.appName }) + "</span>";
    return '<li><button class="win-card' + (window.focused ? " is-front" : "") + (window.minimized ? " is-minimized" : "") + '" type="button" data-pid="' + window.pid + '" data-id="' + window.id + '" aria-label="' + escapeHtml((window.title || window.appName) + ", " + window.appName) + '">' +
      '<span class="win-card__frame" style="--ratio:' + ratio.toFixed(3) + '">' + preview + (window.minimized ? '<span class="win-card__tag">Minimised</span>' : window.focused ? '<span class="win-card__tag">In front</span>' : "") + "</span>" +
      '<span class="win-card__meta">' + renderAppIcon({ id: window.appId, name: window.appName }) + '<span><strong>' + escapeHtml(window.title || window.appName) + "</strong><small>" + escapeHtml(window.appName) + "</small></span></span></button></li>";
  }

  function paint(data) {
    list = data.windows || [];
    loadedAt = data.at || Date.now();
    $("windows-permission").hidden = data.permission?.screenRecording !== false;
    $("windows-status").textContent = list.length ? list.length + (list.length === 1 ? " window" : " windows") + " · tap one to bring it to the front" : "No windows open on your Mac.";
    // Group by app, keeping the front app first.
    const order = [...new Set(list.map((window) => window.appName))];
    const sorted = [...list].sort((a, b) => (b.focused - a.focused) || order.indexOf(a.appName) - order.indexOf(b.appName));
    $("windows-grid").innerHTML = sorted.map(card).join("") || '<li class="cards-empty">Nothing is open right now.</li>';
  }

  async function refresh() {
    try { paint(await api("/api/windows")); }
    catch (error) { $("windows-status").textContent = error.message; }
  }

  function open() {
    if (!isReady() || isOpen) return;
    isOpen = true;
    page.hidden = false;
    page.style.transform = "";
    requestAnimationFrame(() => page.classList.add("is-open"));
    document.body.classList.add("has-panel");
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearInterval(timer);
    page.classList.remove("is-open");
    page.style.transform = "";
    document.body.classList.remove("has-panel");
    setTimeout(() => { if (!page.classList.contains("is-open")) page.hidden = true; }, 320);
  }

  // Tap a card: bring that window forward, then get out of the way.
  $("windows-grid").addEventListener("click", async (event) => {
    const button = event.target.closest(".win-card");
    if (!button) return;
    button.classList.add("is-opening");
    try {
      await api("/api/windows/focus", { method: "POST", body: JSON.stringify({ pid: Number(button.dataset.pid), id: Number(button.dataset.id) }) });
      close();
    } catch (error) { button.classList.remove("is-opening"); report(error); refresh(); }
  });
  $("windows-close").addEventListener("click", close);
  page.addEventListener("click", (event) => { if (event.target === page || event.target.id === "windows-grid") close(); });
  $("windows-ask").addEventListener("click", async () => {
    try { await api("/api/windows/permission", { method: "POST" }); notify("Check your Mac: allow Screen Recording for MacDoc, then reopen this page."); }
    catch (error) { report(error); }
  });
  $("edge-top").addEventListener("click", open);
  addEventListener("keydown", (event) => { if (event.key === "Escape" && isOpen) close(); });

  function suppressNextClick() {
    const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, { capture: true }), 400);
  }

  // Swipe down on the dock opens; swipe up on the page (when it isn't scrolling) closes.
  let down = null;
  $("dock").addEventListener("pointerdown", (event) => {
    if (document.body.classList.contains("is-arranging")) return;
    down = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  addEventListener("pointerup", (event) => {
    if (down?.id !== event.pointerId) return;
    const dx = event.clientX - down.x, dy = event.clientY - down.y;
    down = null;
    if (dy > 70 && dy > Math.abs(dx) * 1.5) {
      suppressNextClick(); // the finger's release must not also tap the tile it started on
      open();
    }
  });
  let up = null;
  page.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") && !event.target.closest(".cards-page__grip")) { up = { id: event.pointerId, y: event.clientY, scroll: page.scrollTop, fromCard: true }; return; }
    up = { id: event.pointerId, y: event.clientY, scroll: page.scrollTop };
  });
  page.addEventListener("pointermove", (event) => {
    if (up?.id !== event.pointerId) return;
    const dy = event.clientY - up.y;
    // Follow the finger only when the page is at the bottom or can't scroll.
    const atBottom = page.scrollTop + page.clientHeight >= page.scrollHeight - 2;
    if (dy < -10 && atBottom) { page.style.transition = "none"; page.style.transform = `translateY(${Math.min(0, dy)}px)`; up.moving = true; }
  });
  page.addEventListener("pointerup", (event) => {
    if (up?.id !== event.pointerId) return;
    const dy = event.clientY - up.y, moving = up.moving;
    up = null;
    page.style.transition = "";
    if (moving && dy < -innerHeight * 0.2) {
      suppressNextClick();
      close();
    } else page.style.transform = "";
  });
  page.addEventListener("pointercancel", () => { up = null; page.style.transition = ""; page.style.transform = ""; });

  return { open, close, get isOpen() { return isOpen; } };
}
