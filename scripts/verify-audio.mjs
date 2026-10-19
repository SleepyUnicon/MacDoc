import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createChecker } from "./lib/assert.mjs";
import { createMacMixer } from "../src/platform/mac-mixer.js";
import { createMacProvider } from "../src/platform/macos.js";
import { createApp } from "../server.js";

const t = createChecker("audio");
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// A stand-in for `MacDocAudio mixer` that records what Node writes.
const children = [];
function spawn(file, args, options) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.lines = [];
  child.stdin.on("data", (data) => child.lines.push(...data.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line))));
  child.kill = () => child.emit("close", null);
  child.message = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  children.push({ child, file, args, options });
  return child;
}
/** Answer every `set` the way the helper does. */
function autoReply(child, reply = (line) => ({ type: "state", bundleId: line.bundleId, volume: line.volume, muted: line.muted, active: line.volume < 100 || line.muted })) {
  child.stdin.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean).map((text) => JSON.parse(text))) {
      if (line.type === "set") setImmediate(() => child.message(reply(line)));
    }
  });
}

// ---------- mixer bridge ----------
const mixer = createMacMixer({ helperPath: "/opt/Mac Doc/MacDocAudio", spawn, replyMs: 200 });
t.deepEqual(await mixer.set("com.google.Chrome", { volume: 100, muted: false }), { volume: 100, muted: false, active: false }, "an untouched app at 100% needs no helper");
t.equal(children.length, 0, "nothing is tapped (and no permission asked) until a slider moves");

let pending = mixer.set("com.google.Chrome", { volume: 40 });
const first = children.at(-1);
t.equal(first.file, "/opt/Mac Doc/MacDocAudio", "mixer runs the built helper");
t.deepEqual(first.args, ["mixer"], "mixer uses a fixed verb");
t.equal(first.options.shell, false, "no shell interpolation");
await wait();
t.deepEqual(first.child.lines.at(-1), { type: "set", bundleId: "com.google.Chrome", volume: 40, muted: false }, "helper receives the validated level");
first.child.message({ type: "state", bundleId: "com.google.Chrome", volume: 40, muted: false, active: true });
t.deepEqual(await pending, { volume: 40, muted: false, active: true }, "set resolves with the helper's state");
t.deepEqual(mixer.level("com.google.Chrome"), { volume: 40, muted: false, active: true }, "level remembered");
t.equal(mixer.status.permission, "granted", "a tapped app means permission was granted");

autoReply(first.child);
t.deepEqual(await mixer.set("com.google.Chrome", { muted: true }), { volume: 40, muted: true, active: true }, "mute keeps the chosen volume");
t.equal(children.length, 1, "one long-lived helper serves every change");
await mixer.set("com.google.Chrome", { volume: 100, muted: false });
t.equal(mixer.level("com.google.Chrome"), null, "back at 100% the app is forgotten (tap released)");

for (const [bundleId, change] of [["../etc", { volume: 10 }], ["com.x", { volume: 101 }], ["com.x", { volume: 5.5 }], ["com.x", { volume: -1 }], ["com.x", { muted: "yes" }], ["", { volume: 1 }]]) {
  await t.rejects(() => mixer.set(bundleId, change), `invalid change rejected before reaching the helper (${bundleId} ${JSON.stringify(change)})`);
}
const sent = first.child.lines.length;
t.equal(first.child.lines.length, sent, "rejected changes never reach the helper");

// Apps quitting and the helper restarting.
await mixer.set("com.brave.Browser", { volume: 30 });
first.child.message({ type: "released", bundleId: "com.brave.Browser" }); await wait();
t.equal(mixer.level("com.brave.Browser"), null, "a quit app is forgotten");
await mixer.set("org.mozilla.firefox", { volume: 25 });
first.child.emit("close", 0); await wait();
t.equal(mixer.level("org.mozilla.firefox").active, false, "taps go with the helper");
await mixer.set("com.microsoft.edgemac", { volume: 70 });
const second = children.at(-1);
t.ok(second !== first, "next change restarts the helper");
await wait();
t.deepEqual(second.child.lines.map((line) => line.bundleId), ["org.mozilla.firefox", "com.microsoft.edgemac"], "restarted helper gets remembered levels back");

// Permission denied.
const deniedMixer = createMacMixer({ helperPath: "/tmp/MacDocAudio", spawn, replyMs: 200 });
pending = deniedMixer.set("com.apple.Safari", { volume: 20 });
const denied = children.at(-1);
denied.child.message({ type: "denied", bundleId: "com.apple.Safari", app: "MacDocAudio" });
let error = await pending.catch((e) => e);
t.equal(error?.status, 403, "missing permission is a 403");
t.ok(/System Audio Recording/.test(error?.message) && /MacDocAudio/.test(error?.message), "message says which permission and which app to allow");
t.equal(deniedMixer.level("com.apple.Safari"), null, "denied apps keep playing normally");
t.equal(deniedMixer.status.permission, "denied", "status reports the denial");
pending = deniedMixer.set("com.apple.Safari", { volume: 20 });
children.at(-1).child.message({ type: "denied", bundleId: "com.apple.Safari", app: "Terminal; rm -rf ~" });
error = await pending.catch((e) => e);
t.ok(!/rm -rf/.test(error.message), "helper-supplied app names are checked before display");

// Older macOS.
const oldMixer = createMacMixer({ helperPath: "/tmp/MacDocAudio", spawn, replyMs: 50 });
pending = oldMixer.set("com.apple.Safari", { volume: 20 });
children.at(-1).child.message({ type: "ready", supported: false });
await pending;
await t.rejects(() => oldMixer.set("com.apple.Safari", { volume: 10 }), "unsupported macOS refuses changes");
t.ok(/14\.2/.test(oldMixer.status.error), "unsupported macOS explains the requirement");
mixer.dispose(); deniedMixer.dispose(); oldMixer.dispose();
t.ok(second.child.lines.at(-1)?.type === "release", "dispose asks the helper to release its taps");

// ---------- macOS provider ----------
const calls = [];
let listed = [
  { pid: 10, app: "/Applications/Spotify.app", name: "Spotify", bundleId: "com.spotify.client", playing: true },
  { pid: 11, app: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome", playing: true },
  { pid: 12, app: "/Applications/Slack.app", name: "Slack", bundleId: "com.tinyspeck.slackmacgap", playing: false },
];
let spotifyVolume = 64, permission = "granted";
async function exec(file, args) {
  calls.push([file, args]);
  if (file === "/tmp/MacDocAudio" && args[0] === "list") return { stdout: JSON.stringify(listed) };
  if (file === "/tmp/MacDocAudio" && args[0] === "check") return { stdout: JSON.stringify({ permission, app: "MacDocAudio" }) };
  if (file === "osascript" && /get volume settings/.test(args[1])) return { stdout: "50,false" };
  if (file === "osascript" && /return sound volume/.test(args[1])) return { stdout: String(spotifyVolume) };
  if (file === "osascript" && /set sound volume/.test(args[1])) { spotifyVolume = Number(args[2]); return { stdout: "" }; }
  return { stdout: "" };
}
const provider = createMacProvider({ exec, audioHelperPath: "/tmp/MacDocAudio", inputHelperPath: "/tmp/MacDocInput", spawn });
let mix = await provider.audioMixer();
t.deepEqual(mix.apps.map((app) => [app.name, app.adjustable, app.via, app.volume, app.muted]), [["Spotify", true, "player", 64, false], ["Google Chrome", true, "mixer", 100, false]], "every playing app is adjustable; scriptable players keep their own volume");
t.equal(mix.mixer.permission, "granted", "permission read without prompting");

const before = children.length;
await provider.setAppVolume("com.spotify.client", 30);
t.equal(children.length, before, "scriptable players never start the tap engine");
t.deepEqual(calls.at(-1), ["osascript", ["-e", 'on run argv\ntell application id "com.spotify.client"\nset sound volume to (item 1 of argv as integer)\nend tell\nend run', "30"]], "Spotify volume goes through its AppleScript with argv");

await provider.setAppMute("com.spotify.client", true);
t.equal(spotifyVolume, 0, "muting a player sets it to 0");
mix = await provider.audioMixer();
t.deepEqual(mix.apps.find((app) => app.name === "Spotify"), { id: "/applications/spotify.app", name: "Spotify", bundleId: "com.spotify.client", playing: true, adjustable: true, via: "player", volume: 30, muted: true }, "a muted player shows the volume it will return to");
await provider.setAppMute("com.spotify.client", false);
t.equal(spotifyVolume, 30, "unmuting a player restores its volume");

const chrome = provider.setAppVolume("com.google.Chrome", 35);
const engine = children.at(-1);
t.deepEqual(engine.args, ["mixer"], "other apps start the tap engine");
await wait();
engine.child.message({ type: "state", bundleId: "com.google.Chrome", volume: 35, muted: false, active: true });
autoReply(engine.child);
t.deepEqual(await chrome, { volume: 35, muted: false, active: true }, "Chrome volume set through the engine");
await provider.setAppMute("com.tinyspeck.slackmacgap", true);
mix = await provider.audioMixer();
t.deepEqual(mix.apps.map((app) => [app.name, app.volume, app.muted]), [["Spotify", 30, false], ["Google Chrome", 35, false], ["Slack", 100, true]], "quiet apps stay listed while turned down or muted");

permission = "denied";
await wait(1);
const freshProvider = createMacProvider({ exec, audioHelperPath: "/tmp/MacDocAudio", inputHelperPath: "/tmp/MacDocInput", spawn });
mix = await freshProvider.audioMixer();
t.ok(/System Audio Recording/.test(mix.mixer.message), "the panel status explains a missing permission");
await t.rejects(() => provider.setAppVolume("com.google.Chrome", 101), "provider rejects out-of-range volume");
provider.dispose(); freshProvider.dispose(); provider.input.dispose(); freshProvider.input.dispose();

// ---------- HTTP route ----------
const changes = [];
const fake = {
  id: "test", displayName: "Test", listRunningApps: async () => [],
  audioMixer: async () => ({ output: { volume: 50, muted: false }, apps: [], helper: true, mixer: { supported: true, permission: "granted", message: "" } }),
  setAppVolume: async (bundleId, volume) => { changes.push(["volume", bundleId, volume]); },
  setAppMute: async (bundleId, muted) => {
    if (bundleId === "com.denied") throw Object.assign(new Error("Allow MacDocAudio…"), { status: 403 });
    changes.push(["mute", bundleId, muted]);
  },
};
const app = await createApp({ provider: fake, pin: "4321", trustLoopback: false, configStore: { load: async () => ({ tiles: [] }) } });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let cookie = "";
async function request(path, body) {
  const res = await fetch(base + path, { method: body ? "POST" : "GET", headers: { cookie, origin: base, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (res.headers.has("set-cookie")) cookie = res.headers.get("set-cookie").split(";")[0];
  return { code: res.status, data: await res.json() };
}
try {
  t.equal((await request("/api/audio/app", { bundleId: "com.google.Chrome", volume: 10 })).code, 401, "app volume needs pairing");
  await request("/api/auth", { pin: "4321" });
  t.equal((await request("/api/audio")).data.mixer.permission, "granted", "mixer status reaches the panel");
  t.equal((await request("/api/audio/app", { bundleId: "com.google.Chrome", volume: 10 })).code, 200, "volume change accepted");
  t.equal((await request("/api/audio/app", { bundleId: "com.google.Chrome", muted: true })).code, 200, "mute accepted on its own");
  t.equal((await request("/api/audio/app", { bundleId: "com.google.Chrome", volume: 60, muted: false })).code, 200, "volume and unmute together");
  t.deepEqual(changes, [["volume", "com.google.Chrome", 10], ["mute", "com.google.Chrome", true], ["volume", "com.google.Chrome", 60], ["mute", "com.google.Chrome", false]], "route calls the provider in order");
  for (const body of [{ bundleId: "com.google.Chrome" }, { bundleId: "com.google.Chrome", muted: "true" }, { bundleId: "com.google.Chrome", volume: 200 }, { bundleId: "a b", volume: 1 }]) {
    t.equal((await request("/api/audio/app", body)).code, 400, `bad body rejected (${JSON.stringify(body)})`);
  }
  const deniedReply = await request("/api/audio/app", { bundleId: "com.denied", muted: true });
  t.ok(deniedReply.code === 403 && /MacDocAudio/.test(deniedReply.data.error), "permission message reaches the tablet");
} finally {
  await app.inputHub?.close(); await app.hub.close(); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve));
}
t.done("audio verification passed");
