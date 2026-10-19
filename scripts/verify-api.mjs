/** G9: the HTTP API serves its documented routes under a live server. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, Agent } from "node:http";
import { createChecker } from "./lib/assert.mjs";
import { createApp } from "../server.js";
import { createMacProvider, appIdFromBundle } from "../src/platform/macos.js";
import { createConfigStore } from "../src/config.js";
import { makeApp } from "./lib/mac-fixtures.mjs";

const t = createChecker("api");
const PIN = "4321";
const AUDIO = "/opt/macdoc/MacDocAudio";
const WINDOWS = "/opt/macdoc/MacDocWindows";

const appsDir = await mkdtemp(join(tmpdir(), "macdoc-api-apps-"));
const safari = await makeApp(appsDir, "Safari.app");
const notes = await makeApp(appsDir, "Notes.app");
const SAFARI_ID = appIdFromBundle(safari);
const NOTES_ID = appIdFromBundle(notes);

const execCalls = [];
const provider = createMacProvider({
  appDirs: [appsDir],
  extraApps: [],
  audioHelperPath: AUDIO,
  windowsHelperPath: WINDOWS,
  inputHelperPath: "/opt/macdoc/MacDocInput",
  exec: async (file, args) => {
    execCalls.push({ file, args: [...args] });
    if (file === "ps") return { stdout: `4812 ${safari}/Contents/MacOS/Safari\n` };
    if (file === "osascript" && args[0] === "-l" && args.at(-1) === "info") {
      return { stdout: JSON.stringify({ bundleId: "com.spotify.client", appName: "Spotify", title: "Track", artist: "Band", playing: true }) };
    }
    if (file === "osascript" && args[1]?.includes("get volume settings") && !args[1].includes("argv")) return { stdout: "35,false" };
    if (file === AUDIO) return { stdout: "[]" };
    if (file === "pmset") return { stdout: "Now drawing from 'Battery Power'\n -InternalBattery-0\t61%; discharging" };
    return { stdout: "" };
  },
});
const lastExec = () => execCalls.at(-1);

const dir = await mkdtemp(join(tmpdir(), "macdoc-api-"));
const configStore = createConfigStore({ path: join(dir, "config.json") });
// Loopback trust would short-circuit every auth check, since these requests
// originate from 127.0.0.1. Disabling it makes the entire suite below exercise
// the real pairing + session path; loopback trust itself is verified separately
// at the end of this file.
const app = await createApp({ provider, configStore, pin: PIN, trustLoopback: false });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;

let cookie = "";
async function call(path, { method = "GET", body, origin = base, withCookie = true } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  if (withCookie && cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response (static asset) */
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ---- public routes ----
const health = await call("/health");
t.equal(health.status, 200, "GET /health is public and returns 200");
t.equal(health.json.ok, true, "health reports ok");
t.equal(health.json.platform, "macos", "health names the active provider");

// ---- static ----
const index = await call("/");
t.equal(index.status, 200, "GET / serves the PWA shell");
t.ok(index.text.includes("<title>MacDoc</title>"), "the shell carries the app title");
t.equal(index.headers.get("x-content-type-options"), "nosniff", "static responses set nosniff");
const manifest = await call("/manifest.webmanifest");
t.equal(manifest.status, 200, "the manifest is served");
t.ok(manifest.headers.get("content-type").includes("manifest+json"), "manifest content type is correct");
t.equal((await call("/does-not-exist.js")).status, 404, "a missing asset returns 404");
t.equal((await call("/../server.js")).status, 404, "traversal above public is refused");

// ---- pairing ----
t.equal((await call("/api/auth", { method: "POST", body: { pin: "0000" } })).status, 401, "a wrong pin is refused");
t.equal((await call("/api/auth", { method: "POST", body: { pin: "12" } })).status, 400, "a malformed pin is refused");
t.equal(
  (await call("/api/auth", { method: "POST", body: { pin: PIN }, origin: "http://evil.test" })).status,
  403,
  "a cross-origin pairing attempt is refused",
);
const paired = await call("/api/auth", { method: "POST", body: { pin: PIN } });
t.equal(paired.status, 200, "the correct pin pairs successfully");
t.ok(cookie.startsWith("macdoc_session="), "pairing issues a session cookie");

// ---- authenticated routes ----
const state = await call("/api/state");
t.equal(state.status, 200, "GET /api/state succeeds when paired");
t.equal(state.json.platform, "macos", "state names the provider");
t.ok(!state.json.verbs.includes("brightness-set"), "state no longer advertises brightness-set");
t.ok(Array.isArray(state.json.tiles), "state carries a tiles array");
t.ok(Array.isArray(state.json.running), "state carries a running array");
t.ok(Array.isArray(state.json.verbs), "state advertises the control verbs");

const installed = await call("/api/apps/installed");
t.equal(installed.status, 200, "GET /api/apps/installed succeeds");
t.equal(installed.json.apps.length, 2, "the installed inventory is returned");
t.deepEqual(installed.json.apps.map((a) => a.name), ["Notes", "Safari"], "the inventory comes from the .app bundles on disk");

// ---- tiles ----
const put = await call("/api/tiles", {
  method: "PUT",
  body: {
    tiles: [
      { kind: "app", id: SAFARI_ID, target: safari, label: "Safari" },
      { kind: "control", verb: "mute-toggle", label: "Mute" },
      { kind: "control", verb: "hack; rm -rf /", label: "Bad" },
    ],
  },
});
t.equal(put.status, 200, "PUT /api/tiles succeeds");
t.equal(put.json.tiles.length, 2, "the hostile tile is dropped on save");
t.ok(put.json.tiles.every((x) => x.verb !== "hack; rm -rf /"), "no hostile verb is persisted");

const after = await call("/api/state");
const ffTile = after.json.tiles.find((x) => x.kind === "app");
t.equal(ffTile.running, true, "a pinned app with a live process is marked running");

// ---- actions ----
const launch = await call("/api/apps/launch", { method: "POST", body: { id: NOTES_ID } });
t.equal(launch.status, 200, "POST /api/apps/launch succeeds for a known app");
t.deepEqual(lastExec(), { file: "open", args: ["-a", notes] }, "launch reaches open with exact argv");
const beforeUnknown = execCalls.length;
t.equal((await call("/api/apps/launch", { method: "POST", body: { id: "/applications/nope.app" } })).status, 404,
  "launching an unknown app returns 404");
t.equal((await call("/api/apps/launch", { method: "POST", body: { id: "/bin/sh" } })).status, 404,
  "an arbitrary path cannot be launched");
t.ok(!execCalls.slice(beforeUnknown).some((c) => c.file === "open"), "unknown apps never reach open");

const focus = await call("/api/apps/focus", { method: "POST", body: { pid: 4812 } });
t.equal(focus.status, 200, "POST /api/apps/focus succeeds for a live pid");
t.deepEqual(lastExec(), { file: "open", args: ["-a", safari] }, "focus reaches open with the running bundle");
const closeApp = await call("/api/apps/close", { method: "POST", body: { pid: 4812 } });
t.equal(closeApp.status, 200, "POST /api/apps/close succeeds for a live pid");
t.equal(lastExec().file, "osascript", "close asks the app to quit through osascript");
t.equal(lastExec().args.at(-1), safari, "close passes the running bundle as its own argv entry");
t.equal((await call("/api/apps/focus", { method: "POST", body: { pid: 999999 } })).status, 404,
  "focusing a dead pid returns 404");
t.equal((await call("/api/apps/focus", { method: "POST", body: { pid: -1 } })).status, 400,
  "a negative pid is rejected");
t.equal((await call("/api/apps/focus", { method: "POST", body: { pid: "4812; id" } })).status, 400,
  "a non-numeric pid is rejected");

const control = await call("/api/control", { method: "POST", body: { verb: "volume-set", value: 30 } });
t.equal(control.status, 200, "POST /api/control succeeds for a valid verb");
t.equal(lastExec().file, "osascript", "control reaches osascript");
t.equal(lastExec().args.at(-1), "30", "the volume reaches osascript as its own argv entry");
const beforeBrightness = execCalls.length;
const brightness = await call("/api/control", { method: "POST", body: { verb: "brightness-set", value: 50 } });
t.equal(brightness.status, 400, "the removed brightness-set verb is rejected");
t.equal(execCalls.length, beforeBrightness, "a rejected brightness request runs nothing");
t.equal((await call("/api/control", { method: "POST", body: { verb: "nope" } })).status, 400,
  "an unknown verb is rejected");
t.equal((await call("/api/control", { method: "POST", body: { verb: "volume-set", value: 500 } })).status, 400,
  "an out-of-range value is rejected");

const np = await call("/api/nowplaying");
t.equal(np.status, 200, "GET /api/nowplaying succeeds");
t.equal(np.json.nowPlaying.title, "Track", "now playing reports the current title");

const stats = await call("/api/stats");
t.equal(stats.status, 200, "GET /api/stats succeeds");
t.equal(stats.json.battery, 61, "stats report the Mac battery");
t.deepEqual((await call("/api/volume")).json, { volume: 35, muted: false }, "GET /api/volume reports the output volume");
t.equal((await call("/api/nope")).status, 404, "an unknown API route returns 404");
for (const removed of ["/api/capture", "/api/capture/screen", "/api/capture/window?id=1"]) {
  t.equal((await call(removed)).status, 404, `the removed screen-capture route is gone: ${removed}`);
}
t.equal((await call("/api/capture", { method: "POST", body: {} })).status, 404, "posting to the removed capture route is a 404");

// ---- CSRF and body limits ----
t.equal(
  (await call("/api/control", { method: "POST", body: { verb: "lock" }, origin: "http://evil.test" })).status,
  403,
  "a cross-origin state change is refused even with a valid session",
);
const big = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie, origin: base },
  body: JSON.stringify({ tiles: Array.from({ length: 200000 }, () => ({ kind: "control", verb: "lock" })) }),
});
t.equal(big.status, 413, "an oversized body is refused");
t.equal((await big.json()).error, "body too large", "the entire 413 response arrives without a reset");

// Exercise an upload without Content-Length and reuse exactly one connection.
// The body limit must reject it before persistence and leave the socket usable.
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
function rawCall(method, path, chunks = []) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, {
      method, agent, headers: { cookie, origin: base, "content-type": "application/json" },
    }, (res) => {
      const data = [];
      res.on("data", (chunk) => data.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString(), reused: req.reusedSocket }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
try {
  const chunked = await rawCall("PUT", "/api/tiles", Array(20).fill("x".repeat(8192)));
  t.equal(chunked.status, 413, "an oversized chunked body is refused");
  t.equal(JSON.parse(chunked.body).error, "body too large", "chunked rejection has a complete response");
  const following = await rawCall("GET", "/api/tiles");
  t.equal(following.reused, true, "follow-up uses the same keep-alive socket");
  t.equal(following.status, 200, "the next request succeeds on that socket");
  t.equal(JSON.parse(following.body).tiles.length, 2, "rejected uploads do not overwrite tiles");
} finally {
  agent.destroy();
}

const badJson = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie, origin: base },
  body: "{not json",
});
t.equal(badJson.status, 400, "a malformed JSON body is refused");
await badJson.arrayBuffer();

// ---- unauthenticated access ----
const saved = cookie;
cookie = "";
const anon = await fetch(`${base}/api/state`, { headers: { origin: base, cookie: "macdoc_session=bogus" } });
t.equal(anon.status, 401, "an invalid session cannot read state");
await anon.arrayBuffer();
const anonAction = await fetch(`${base}/api/control`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie: "macdoc_session=bogus" },
  body: JSON.stringify({ verb: "shutdown" }),
});
t.equal(anonAction.status, 401, "an invalid session cannot trigger a power action");
await anonAction.arrayBuffer();
cookie = saved;

// ---- loopback trust is a real feature: verify it works when enabled ----
const trusting = await createApp({ provider, configStore, pin: PIN, trustLoopback: true });
await new Promise((r) => trusting.server.listen(0, "127.0.0.1", r));
const tport = trusting.server.address().port;
const trusted = await fetch(`http://127.0.0.1:${tport}/api/state`);
t.equal(trusted.status, 200, "loopback is trusted when trustLoopback is enabled");
await trusted.arrayBuffer();
await trusting.hub.close();
trusting.server.closeAllConnections?.();
await new Promise((r) => trusting.server.close(r));

await app.hub.close();
// fetch keeps connections alive; close() alone would wait for them forever.
app.server.closeAllConnections?.();
await new Promise((r) => app.server.close(r));
await rm(dir, { recursive: true, force: true });
await rm(appsDir, { recursive: true, force: true });

t.done("api verification passed");
