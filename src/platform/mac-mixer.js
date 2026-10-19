import { spawn as spawnProcess } from "node:child_process";

/**
 * Per-app volume for any Mac app, through the gain engine in
 * native/mac/MacDocAudio.swift (`MacDocAudio mixer`, Core Audio process taps).
 *
 * The helper starts on the first change, so nothing is tapped and no
 * permission is asked for until someone moves an app's slider. It speaks JSON
 * lines; every value Node sends has been validated here first. If the helper
 * dies, macOS drops its taps and every app plays normally again; the next
 * change restarts it and puts the remembered levels back.
 */

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,200}$/;
const APP_NAME = /^[\p{L}\p{N} ._()&+-]{1,64}$/u;
const userError = (message, status) => Object.assign(new Error(message), { status, userMessage: message });

export const deniedMessage = (app = "MacDocAudio") =>
  `Allow ${app} in System Settings › Privacy & Security › Screen & System Audio Recording (System Audio Recording Only), then move the slider again.`;

export function createMacMixer({ helperPath, spawn = spawnProcess, replyMs = 2500 } = {}) {
  /** bundleId -> { volume, muted, active } for every app not at plain 100%. */
  const levels = new Map();
  const waiting = new Map();
  let child = null, buffer = "", disposed = false;
  let status = { supported: true, permission: null, app: "MacDocAudio", error: "" };

  function settle(bundleId, error) {
    const resolve = waiting.get(bundleId);
    if (!resolve) return;
    waiting.delete(bundleId);
    resolve(error);
  }

  function handle(event) {
    const bundleId = typeof event.bundleId === "string" && BUNDLE_ID.test(event.bundleId) ? event.bundleId : null;
    if (event.type === "ready") {
      status.supported = event.supported !== false;
      if (!status.supported) status.error = "Per-app volume needs macOS 14.2 or later.";
    } else if (event.type === "state" && bundleId) {
      status.permission = "granted";
      status.error = "";
      const volume = Number.isInteger(event.volume) ? event.volume : 100, muted = event.muted === true;
      if (volume >= 100 && !muted) levels.delete(bundleId);
      else levels.set(bundleId, { volume, muted, active: event.active === true });
      settle(bundleId);
    } else if (event.type === "released" && bundleId) {
      levels.delete(bundleId);
    } else if (event.type === "denied") {
      status.permission = "denied";
      status.app = typeof event.app === "string" && APP_NAME.test(event.app) ? event.app : "MacDocAudio";
      if (bundleId) levels.delete(bundleId);
      if (bundleId) settle(bundleId, userError(deniedMessage(status.app), 403));
    } else if (event.type === "failed" && bundleId) {
      status.error = typeof event.error === "string" ? event.error.slice(0, 160) : "The Mac couldn't change that app's volume.";
      settle(bundleId, userError(status.error, 503));
    }
  }

  function start() {
    if (child) return child;
    if (disposed) throw new Error("Mixer closed");
    const proc = spawn(helperPath, ["mixer"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child = proc;
    buffer = "";
    proc.stderr.resume();
    proc.stdin.on("error", () => {});
    proc.on("error", (error) => {
      status.error = error?.code === "ENOENT" ? "Run npm run build:mac on the Mac to turn apps up or down." : "The Mac's mixer couldn't start.";
      for (const id of [...waiting.keys()]) settle(id, userError(status.error, 503));
    });
    proc.on("close", () => {
      if (child === proc) child = null;
      // macOS released the taps with the process; they come back on the next change.
      for (const level of levels.values()) level.active = false;
      for (const id of [...waiting.keys()]) settle(id);
    });
    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 16384) { proc.kill(); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { handle(JSON.parse(line)); } catch { /* ignore a malformed line */ }
      }
    });
    // A restarted helper picks the remembered levels back up.
    for (const [bundleId, level] of levels) write(proc, bundleId, level.volume, level.muted);
    return proc;
  }

  function write(proc, bundleId, volume, muted) {
    proc.stdin.write(JSON.stringify({ type: "set", bundleId, volume, muted }) + "\n");
  }

  return {
    get status() { return { ...status }; },
    level(bundleId) { return levels.get(bundleId) || null; },
    /** Sets an app's level; resolves once the helper has applied it (or after a short wait). */
    async set(bundleId, { volume, muted } = {}) {
      if (!BUNDLE_ID.test(bundleId || "")) throw userError("bundleId required", 400);
      const current = levels.get(bundleId) || { volume: 100, muted: false };
      const next = { volume: volume ?? current.volume, muted: muted ?? current.muted };
      if (!Number.isInteger(next.volume) || next.volume < 0 || next.volume > 100) throw userError("volume must be 0..100", 400);
      if (typeof next.muted !== "boolean") throw userError("muted must be true or false", 400);
      if (!status.supported) throw userError(status.error, 409);
      // Nothing to undo for an app that was never changed and is going back to normal.
      if (!child && !levels.has(bundleId) && next.volume === 100 && !next.muted) return { ...next, active: false };
      settle(bundleId);
      const reply = new Promise((resolve) => waiting.set(bundleId, resolve));
      const timer = setTimeout(() => settle(bundleId), replyMs);
      write(start(), bundleId, next.volume, next.muted);
      const error = await reply;
      clearTimeout(timer);
      if (error) throw error;
      return levels.get(bundleId) || { ...next, active: false };
    },
    dispose() {
      disposed = true;
      child?.stdin.end('{"type":"release"}\n');
    },
  };
}
