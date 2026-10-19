/**
 * Per-computer host settings, kept beside the dock layout in the user's
 * config folder (never in the repository): a fixed pairing PIN, and the file
 * that remembers paired devices across restarts.
 *
 *   ~/.config/macdoc/host.json      {"pin": "1234"}   (mode 0600)
 *   ~/.config/macdoc/sessions.json  hashed device sessions
 *
 * MACDOC_PIN overrides the file. Without either, each start gets a random PIN.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfigPath } from "./config.js";
import { isValidPinShape } from "./auth.js";

export function settingsDir() {
  return dirname(defaultConfigPath());
}

export function hostSettingsPath(dir = settingsDir()) {
  return join(dir, "host.json");
}

export function sessionsPath(dir = settingsDir()) {
  return join(dir, "sessions.json");
}

/** The fixed PIN, or null when the host should make a new one each start. */
export function configuredPin({ env = process.env, file = hostSettingsPath() } = {}) {
  if (env.MACDOC_PIN !== undefined) {
    if (!isValidPinShape(env.MACDOC_PIN)) throw new Error("MACDOC_PIN must be exactly 4 digits");
    return env.MACDOC_PIN;
  }
  try {
    const pin = JSON.parse(readFileSync(file, "utf8"))?.pin;
    if (pin === undefined || pin === null) return null;
    if (!isValidPinShape(String(pin))) throw new Error(`The PIN in ${file} must be exactly 4 digits`);
    return String(pin);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Save (or with null, clear) the fixed PIN. */
export function savePin(pin, file = hostSettingsPath()) {
  if (pin !== null && !isValidPinShape(pin)) throw new Error("The PIN must be exactly 4 digits");
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { /* new file */ }
  if (pin === null) delete settings.pin; else settings.pin = pin;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp";
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  return file;
}
