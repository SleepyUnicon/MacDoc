/**
 * Pairing and session auth.
 *
 * A 4-digit PIN is shown on the host; a device posts it once and receives an
 * opaque session token. PIN comparison is constant-time, failures are counted
 * per client, and a client is locked out after a threshold. Loopback is trusted
 * so a browser on the Mac itself does not have to pair with the machine the
 * user is already sitting at.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const PIN_LENGTH = 4;
export const MAX_FAILS = 5;
export const LOCK_MS = 60_000;
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
export const COOKIE_NAME = "macdoc_session";

/** Cryptographically uniform PIN; avoids the modulo bias of randomBytes % 10. */
export function newPin(length = PIN_LENGTH) {
  let pin = "";
  for (let i = 0; i < length; i += 1) pin += String(randomInt(0, 10));
  return pin;
}

export function isValidPinShape(value, length = PIN_LENGTH) {
  return typeof value === "string" && new RegExp(`^\\d{${length}}$`).test(value);
}

/** Constant-time compare that never leaks length through early return. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not distinguish length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isLoopback(address) {
  if (typeof address !== "string" || !address) return false;
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.");
}

/** Per-client failure tracking with a time-boxed lockout. */
export function createLockout({ maxFails = MAX_FAILS, lockMs = LOCK_MS, now = Date.now } = {}) {
  const entries = new Map();

  function prune(at) {
    for (const [key, entry] of entries) {
      if (entry.until && entry.until <= at) entries.delete(key);
      else if (!entry.until && at - entry.last > lockMs) entries.delete(key);
    }
  }

  return {
    /** @returns {{locked:boolean, retryInMs:number}} */
    status(key) {
      const at = now();
      const entry = entries.get(key);
      if (!entry || !entry.until) return { locked: false, retryInMs: 0 };
      if (entry.until <= at) {
        entries.delete(key);
        return { locked: false, retryInMs: 0 };
      }
      return { locked: true, retryInMs: entry.until - at };
    },
    recordFailure(key) {
      const at = now();
      prune(at);
      const entry = entries.get(key) || { fails: 0, last: at, until: 0 };
      entry.fails += 1;
      entry.last = at;
      if (entry.fails >= maxFails) entry.until = at + lockMs;
      entries.set(key, entry);
      return { locked: Boolean(entry.until), fails: entry.fails };
    },
    recordSuccess(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}

const hashToken = (token) => createHash("sha256").update(token).digest("base64url");
export const pinFingerprint = (pin) => createHash("sha256").update("macdoc-pin:" + pin).digest("base64url");

/**
 * Opaque session tokens with an expiry.
 *
 * With `file`, paired devices survive a host restart: only a hash of each
 * token is written (mode 0600), together with a fingerprint of the PIN, so
 * changing the PIN signs every device out.
 */
export function createSessionStore({ ttlMs = SESSION_TTL_MS, now = Date.now, file = null, pin = "" } = {}) {
  // hash -> { expiry, name, ip, created, lastSeen }
  const sessions = new Map();
  let fingerprint = file ? pinFingerprint(pin) : "";
  let savedAt = 0;

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved?.pin === fingerprint && saved.sessions && typeof saved.sessions === "object") {
        for (const [hash, value] of Object.entries(saved.sessions)) {
          // Earlier files stored only the expiry.
          const entry = typeof value === "number" ? { expiry: value } : value;
          if (typeof hash === "string" && Number.isFinite(entry?.expiry) && entry.expiry > now()) {
            sessions.set(hash, { expiry: entry.expiry, name: String(entry.name || "Paired device").slice(0, 80), ip: String(entry.ip || "").slice(0, 64), created: entry.created || 0, lastSeen: entry.lastSeen || 0 });
          }
        }
      }
    } catch {
      /* No saved sessions yet, or an unreadable file: start fresh. */
    }
  }

  function persist() {
    if (!file) return;
    savedAt = now();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = file + ".tmp";
      writeFileSync(temp, JSON.stringify({ version: 2, pin: fingerprint, sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      /* Pairing still works for this run; it just won't survive a restart. */
    }
  }

  function prune(at) {
    let changed = false;
    for (const [hash, entry] of sessions) if (entry.expiry <= at) { sessions.delete(hash); changed = true; }
    return changed;
  }

  return {
    /** `meta` names the device in the setup page: { name, ip }. */
    issue(meta = {}) {
      const at = now();
      prune(at);
      const token = randomBytes(32).toString("base64url");
      sessions.set(hashToken(token), { expiry: at + ttlMs, name: String(meta.name || "Paired device").slice(0, 80), ip: String(meta.ip || "").slice(0, 64), created: at, lastSeen: at });
      persist();
      return token;
    },
    /** `seen` refreshes the device's details: { name, ip }. */
    verify(token, seen = {}) {
      if (typeof token !== "string" || !token) return false;
      const hash = hashToken(token);
      const entry = sessions.get(hash);
      if (!entry) return false;
      const at = now();
      if (entry.expiry <= at) {
        sessions.delete(hash);
        persist();
        return false;
      }
      entry.lastSeen = at;
      let changed = false;
      if (seen.ip && seen.ip !== entry.ip) { entry.ip = String(seen.ip).slice(0, 64); changed = true; }
      if (seen.name && entry.name === "Paired device") { entry.name = String(seen.name).slice(0, 80); changed = true; }
      if (changed || at - savedAt > 60_000) persist(); // "last seen" is approximate; don't write on every request
      return true;
    },
    /** Paired devices for the setup page. `id` is the stored hash, never the token. */
    list() {
      if (prune(now())) persist();
      return [...sessions].map(([id, entry]) => ({ id, name: entry.name, ip: entry.ip, created: entry.created, lastSeen: entry.lastSeen }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    },
    revoke(id) {
      const removed = sessions.delete(id);
      if (removed) persist();
      return removed;
    },
    /** A new PIN signs every device out. */
    rekey(nextPin) {
      fingerprint = file ? pinFingerprint(nextPin) : "";
      sessions.clear();
      persist();
    },
    revokeAll() {
      sessions.clear();
      persist();
    },
    get size() {
      if (prune(now())) persist();
      return sessions.size;
    },
  };
}

/** A readable device name from a User-Agent, for the paired-devices list. */
export function deviceName(userAgent = "") {
  const ua = String(userAgent);
  const model = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)?.[1]?.trim();
  if (/Android/.test(ua)) return (/\bwv\b/.test(ua) ? "MacDoc app" : "Browser") + " on " + (model && model !== "K" ? model : "Android");
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  return browser + " on " + os;
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function tokenFromRequest(req) {
  return parseCookies(req?.headers?.cookie)[COOKIE_NAME] || "";
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The authorization decision for one request.
 * `key` is the rate-limit bucket, normally the remote address.
 */
export function authorize({ req, sessions, lockout, remote, trustLoopback = true }) {
  if (trustLoopback && isLoopback(remote)) return { ok: true, via: "loopback" };
  const status = lockout.status(remote);
  if (status.locked) {
    return { ok: false, via: "locked", retryInMs: status.retryInMs, code: 429 };
  }
  const seen = { ip: String(remote || "").replace(/^::ffff:/, ""), name: deviceName(req?.headers?.["user-agent"]) };
  if (sessions.verify(tokenFromRequest(req), seen)) return { ok: true, via: "session" };
  return { ok: false, via: "unauthorized", code: 401 };
}
