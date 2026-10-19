import { escapeHtml } from "./dock.js";

const POLL_MS = 2000;
const native = () => window.MacDocAndroid;

/** Copy text into this device's clipboard: Android bridge, async API, then a legacy fallback. */
async function copyHere(text) {
  try { if (typeof native()?.copyText === "function" && native().copyText(text)) return true; } catch { /* fall through */ }
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure origin */ }
  const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(area); area.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { area.remove(); }
}

/** Read this device's clipboard, or null when the browser does not allow it. */
async function readHere() {
  try { if (typeof native()?.readText === "function") return native().readText(); } catch { /* fall through */ }
  try { return await navigator.clipboard.readText(); } catch { return null; }
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
  return Math.round(seconds / 3600) + " h ago";
}

export function createClipboardSheet({ api, notify, hostName = () => "your Mac" }) {
  const $ = (id) => document.getElementById(id), dialog = $("clipboard");
  let snapshot = { available: false, text: "", history: [] }, timer = null, painted = "";

  function paint() {
    const key = JSON.stringify(snapshot);
    if (key === painted) return;
    painted = key;
    $("clipboard-host-title").textContent = "On " + hostName();
    $("clipboard-current").textContent = snapshot.text || "Nothing copied yet.";
    $("clipboard-current").classList.toggle("is-empty", !snapshot.text);
    $("clipboard-copy").disabled = !snapshot.text;
    $("clipboard-history").innerHTML = snapshot.history.length
      ? snapshot.history.map((entry, index) => '<li><button type="button" data-clip="' + index + '"><span>' + escapeHtml(entry.text.slice(0, 280)) + "</span><small>" + (entry.from === "host" ? "Copied on " + escapeHtml(hostName()) : "Sent from a device") + " · " + ago(entry.at) + "</small></button></li>").join("")
      : '<li class="clipboard__empty">Text you copy appears here while MacDoc is running.</li>';
    $("clipboard-clear").hidden = !snapshot.history.length;
  }
  async function refresh() {
    snapshot = await api("/api/clipboard");
    if (!snapshot.available) $("clipboard-status").textContent = "Clipboard sync isn't available on this host.";
    paint();
  }
  async function send(text) {
    if (!text) return;
    snapshot = await api("/api/clipboard", { method: "POST", body: JSON.stringify({ text }) });
    paint();
    notify("Copied to " + hostName());
  }
  function stop() { clearInterval(timer); timer = null; }

  $("clipboard-copy").addEventListener("click", async () => {
    notify(await copyHere(snapshot.text) ? "Copied to this device" : "Couldn't copy here. Long-press the text instead.", !snapshot.text);
  });
  $("clipboard-paste").addEventListener("click", async () => {
    const text = await readHere();
    if (text === null) return notify("Paste into the box below, then tap Send.", true);
    if (!text) return notify("This device's clipboard is empty.", true);
    $("clipboard-draft").value = text;
    send(text).catch((error) => notify(error.message, true));
  });
  $("clipboard-send").addEventListener("click", () => {
    send($("clipboard-draft").value).then(() => { $("clipboard-draft").value = ""; }).catch((error) => notify(error.message, true));
  });
  $("clipboard-history").addEventListener("click", (event) => {
    const entry = snapshot.history[Number(event.target.closest("[data-clip]")?.dataset.clip)];
    if (entry) send(entry.text).catch((error) => notify(error.message, true));
  });
  $("clipboard-clear").addEventListener("click", async () => {
    try { snapshot = await api("/api/clipboard/history", { method: "DELETE" }); paint(); notify("Clipboard history cleared"); }
    catch (error) { notify(error.message, true); }
  });
  dialog.addEventListener("close", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else if (dialog.open && !timer) timer = setInterval(() => refresh().catch(stop), POLL_MS); });

  return {
    async open() {
      $("clipboard-status").textContent = "Updates automatically while this is open.";
      if (!dialog.open) dialog.showModal();
      stop();
      await refresh();
      timer = setInterval(() => refresh().catch(stop), POLL_MS);
    },
  };
}
