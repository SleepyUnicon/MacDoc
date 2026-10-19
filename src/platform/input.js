import { spawn as spawnProcess } from "node:child_process";
import { validateInput, validateSignature } from "../input.js";

/** User-facing failure with a message the touchpad status can show as-is. */
const userError = (message, extra = {}) => Object.assign(new Error(message), { userMessage: message, ...extra });
const APP_NAME = /^[\p{L}\p{N} ._()&+-]{1,64}$/u;

/**
 * The macOS helper (native/mac/MacDocInput.swift) speaks the same protocol, plus
 * a `denied` event when the Accessibility permission is missing.
 */
export function createMacInput(options = {}) {
  return createHelperInput({
    host: "macOS",
    missing: "The Mac input helper isn't built yet. Run npm run build:mac on the Mac, then reopen the touchpad.",
    denied: (app) => `Allow ${app} in System Settings › Privacy & Security › Accessibility, then reopen the touchpad.`,
    ...options,
  });
}

/** Persistent JSON-lines bridge to a native input helper. */
export function createHelperInput({ helperPath, host = "macOS", missing, denied, spawn = spawnProcess, startupMs = 5000, stopMs = 1800 } = {}) {
  const unavailable = () => userError(`${host} could not save the signature. Check the Pictures folder and try again.`, { status: 503 });
  const startFailed = (error) => userError(error?.code === "ENOENT" && missing ? missing : `${host} could not start the touchpad.`);
  const workers = new Set();
  let disposed = false, saving = false;
  function start(verb) {
    if (disposed) throw new Error("Input service closed");
    const child = spawn(helperPath, [verb], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    workers.add(child);
    child.stderr.resume(); // Native diagnostics never contain signature strokes in responses.
    child.stdin.on("error", () => {});
    child.once("close", () => workers.delete(child));
    return child;
  }
  return {
    open(onFailure = () => {}, onEvent = () => {}) {
      const child = start("touchpad");
      let closed = false, ended = false, buffer = "", closing;
      let resolveReady, rejectReady, resolveExit;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const exited = new Promise((resolve) => { resolveExit = resolve; });
      const startup = setTimeout(() => { rejectReady(new Error("Input startup timeout")); close(); }, startupMs);
      function close() {
        if (closing) return closing;
        closed = true; clearTimeout(startup);
        rejectReady(new Error("Input closed"));
        if (!ended) child.stdin.end('{"type":"release"}\n');
        const kill = setTimeout(() => { if (!ended) child.kill(); }, stopMs);
        closing = exited.finally(() => clearTimeout(kill));
        return closing;
      }
      child.on("error", (error) => { rejectReady(startFailed(error)); if (!closed) onFailure(); close(); });
      child.on("close", () => {
        ended = true; clearTimeout(startup); resolveExit(); rejectReady(new Error("Input worker exited"));
        if (!closed) onFailure(); closed = true;
      });
      child.stdout.on("data", (data) => {
        buffer += data.toString();
        if (buffer.length > 4096) { onFailure(); close(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "ready") { clearTimeout(startup); resolveReady(); }
            else if (event.type === "focus" && /^[1-9][0-9]{0,15}$/.test(event.target) && typeof event.editable === "boolean" && typeof event.password === "boolean") onEvent({ type: "focus", target: event.target, editable: event.editable, password: event.password });
            else if (event.type === "denied" && denied) rejectReady(userError(denied(typeof event.app === "string" && APP_NAME.test(event.app) ? event.app : "the app that runs MacDoc")));
            else if (event.type === "input-error") onEvent({ type: "input-error", error: `Mac focus changed or input was blocked. Select the field and reopen the keyboard.` });
          }
          catch { onFailure(); close(); }
        }
      });
      return { ready, close, send(message) {
        const checked = validateInput(message);
        if (!checked || closed || child.stdin.writableLength > 8192) throw new Error("Input unavailable");
        if (!child.stdin.write(JSON.stringify(checked) + "\n")) throw new Error("Input is falling behind");
      } };
    },
    async saveSignature(body, insert = false) {
      const checked = validateSignature(body);
      if (saving) throw Object.assign(new Error("A signature is already being saved."), { status: 409 });
      saving = true;
      try {
        return await new Promise((resolve, reject) => {
          const child = start(insert ? "signature-insert" : "signature");
          let output = "", failed = false;
          const timer = setTimeout(() => { failed = true; child.kill(); reject(unavailable()); }, 10000);
          child.on("error", (error) => { clearTimeout(timer); failed = true; reject(error?.code === "ENOENT" && missing ? userError(missing, { status: 503 }) : unavailable()); });
          child.stdout.on("data", (data) => { output += data.toString(); if (output.length > 8192) { failed = true; child.kill(); reject(unavailable()); } });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (failed) return;
            try {
              const result = JSON.parse(output);
              if (code !== 0 || result.type !== "saved" || typeof result.path !== "string") throw unavailable();
              resolve(result);
            } catch { reject(unavailable()); }
          });
          child.stdin.end(JSON.stringify(checked));
        });
      } finally { saving = false; }
    },
    dispose() { disposed = true; for (const worker of workers) worker.stdin.end(); },
  };
}
