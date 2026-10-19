/**
 * Clipboard sync between the host and paired devices.
 *
 * The host polls its own clipboard and keeps a short history in memory only;
 * nothing is written to disk, and the history is gone when the host stops.
 * Devices read it and push text back through the authenticated HTTP API, so
 * clipboard access follows the same PIN pairing as every other action.
 */

export const CLIPBOARD_MAX_CHARS = 20_000;
export const HISTORY_SIZE = 20;
export const POLL_MS = 2_000;

export function validateClipboardText(body) {
  const text = body?.text;
  if (typeof text !== "string" || !text.length) {
    throw Object.assign(new Error("text is required"), { status: 400 });
  }
  if (text.length > CLIPBOARD_MAX_CHARS) {
    throw Object.assign(new Error(`clipboard text is limited to ${CLIPBOARD_MAX_CHARS} characters`), { status: 413 });
  }
  return text;
}

export function createClipboardHub({ provider, pollMs = POLL_MS, historySize = HISTORY_SIZE, now = Date.now } = {}) {
  const available = typeof provider?.readClipboard === "function" && typeof provider?.writeClipboard === "function";
  let current = "";
  let history = [];
  let timer = null;

  function remember(text, from) {
    if (!text || !text.trim()) return;
    const clipped = text.slice(0, CLIPBOARD_MAX_CHARS);
    history = [{ text: clipped, from, at: now() }, ...history.filter((entry) => entry.text !== clipped)].slice(0, historySize);
  }

  async function poll() {
    if (!available) return current;
    try {
      const text = String(await provider.readClipboard() ?? "").slice(0, CLIPBOARD_MAX_CHARS);
      if (text !== current) {
        current = text;
        remember(text, "host");
      }
    } catch {
      /* A busy pasteboard is retried on the next tick. */
    }
    return current;
  }

  return {
    available,
    async snapshot() {
      await poll();
      return { available, text: current, history };
    },
    async write(text, from = "device") {
      if (!available) throw Object.assign(new Error("Clipboard sync isn't supported on this host."), { status: 501 });
      await provider.writeClipboard(text);
      current = text;
      remember(text, from);
      return { available, text: current, history };
    },
    clearHistory() {
      history = [];
      return { available, text: current, history };
    },
    start() {
      if (!available || timer) return;
      poll();
      timer = setInterval(poll, pollMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
