/** G5: every declared control verb maps to a native action on every provider. */
import { createChecker } from "./lib/assert.mjs";
import {
  CONTROL_VERBS,
  CONTROL_VERB_RANGES,
  DESTRUCTIVE_VERBS,
  validateControl,
  isControlVerb,
  isDestructiveVerb,
} from "../src/platform/contract.js";
import { createMacProvider, MAC_CONTROL } from "../src/platform/macos.js";
import { createLinuxProvider, LINUX_CONTROL } from "../src/platform/linux.js";

const t = createChecker("control");
const WINDOWS_HELPER = "/opt/macdoc/MacDocWindows";
const AUDIO_HELPER = "/opt/macdoc/MacDocAudio";

// Completeness: no declared verb may be silently unimplemented on either OS.
t.deepEqual(CONTROL_VERBS.filter((v) => !MAC_CONTROL[v]), [], "every contract verb is mapped on macOS");
t.deepEqual(
  CONTROL_VERBS.filter((v) => !LINUX_CONTROL[v]),
  [],
  "every contract verb is mapped on Linux",
);
t.equal(Object.keys(MAC_CONTROL).length, CONTROL_VERBS.length, "macOS map has no extra verbs");
t.equal(Object.keys(LINUX_CONTROL).length, CONTROL_VERBS.length, "Linux map has no extra verbs");
t.equal(CONTROL_VERBS.length, 12, `expected exactly 12 verbs, found ${CONTROL_VERBS.length}`);
t.ok(!CONTROL_VERBS.includes("brightness-set"), "brightness-set is no longer a control verb");
t.ok(!("brightness-set" in CONTROL_VERB_RANGES), "brightness-set has no declared range");
t.ok(!validateControl("brightness-set", 50).ok, "brightness-set is rejected by the validator");

// Non-media verbs build a fixed argv; a valued verb appends its integer as its own entry.
for (const verb of CONTROL_VERBS.filter((v) => !v.startsWith("media-"))) {
  const ranged = CONTROL_VERB_RANGES[verb];
  const [file, args] = MAC_CONTROL[verb](ranged ? ranged.min : null, null);
  t.ok(["osascript", "pmset"].includes(file), `${verb} runs a fixed Apple binary (${file})`);
  t.ok(Array.isArray(args) && args.every((a) => typeof a === "string"), `${verb} argv is all strings`);
  if (ranged) t.equal(args.at(-1), String(ranged.min), `${verb} passes its value as the last argv entry`);
}
// Media verbs only drive allowlisted players, and refuse anything else.
for (const verb of CONTROL_VERBS.filter((v) => v.startsWith("media-"))) {
  const [file, args] = MAC_CONTROL[verb](null, "Spotify");
  t.equal(file, "osascript", `${verb} drives a player through osascript`);
  t.ok(args[1].startsWith('tell application "Spotify" to '), `${verb} names an allowlisted player`);
  t.throws(() => MAC_CONTROL[verb](null, 'Evil" to do shell script "id'), `${verb} refuses a non-allowlisted player`);
}

// Range enforcement, including the boundaries.
for (const [verb, range] of Object.entries(CONTROL_VERB_RANGES)) {
  t.ok(validateControl(verb, range.min).ok, `${verb} accepts its minimum ${range.min}`);
  t.ok(validateControl(verb, range.max).ok, `${verb} accepts its maximum ${range.max}`);
  t.ok(!validateControl(verb, range.min - 1).ok, `${verb} rejects below minimum`);
  t.ok(!validateControl(verb, range.max + 1).ok, `${verb} rejects above maximum`);
  t.ok(!validateControl(verb, 50.5).ok, `${verb} rejects a non-integer`);
  t.ok(!validateControl(verb, "50").ok, `${verb} rejects a numeric string`);
  t.ok(!validateControl(verb, NaN).ok, `${verb} rejects NaN`);
  t.ok(!validateControl(verb, null).ok, `${verb} requires a value`);
}

// A valueless verb must refuse a stray value rather than pass it to argv.
t.ok(!validateControl("mute-toggle", 5).ok, "valueless verb rejects an unexpected value");
t.ok(validateControl("mute-toggle", null).ok, "valueless verb accepts a null value");

// Negative control: unknown verbs never reach a command line.
for (const bad of ["reboot-now", "", "VOLUME-UP", "lock; rm -rf /", null, 42, {}]) {
  t.ok(!validateControl(bad, null).ok, `unknown verb rejected: ${JSON.stringify(bad)}`);
  t.ok(!isControlVerb(bad), `isControlVerb false for ${JSON.stringify(bad)}`);
  t.ok(typeof bad !== "string" || !Object.hasOwn(MAC_CONTROL, bad), `no macOS argv exists for ${JSON.stringify(bad)}`);
}

t.deepEqual([...DESTRUCTIVE_VERBS], ["lock", "sleep", "shutdown", "restart"], "destructive set is exact");
t.ok(isDestructiveVerb("shutdown"), "shutdown is destructive");
t.ok(!isDestructiveVerb("volume-up"), "volume-up is not destructive");

// Providers must dispatch the mapped argv and nothing else.
function macRecorder(respond = () => "") {
  const calls = [];
  const provider = createMacProvider({
    appDirs: [],
    extraApps: [],
    windowsHelperPath: WINDOWS_HELPER,
    audioHelperPath: AUDIO_HELPER,
    exec: async (file, args) => {
      calls.push({ file, args: [...args] });
      return { stdout: await respond(file, args) };
    },
  });
  return { calls, provider };
}
const osa = (call) => call.file === "osascript";

let { calls, provider: mac } = macRecorder();
await mac.control("volume-set", 40);
t.equal(calls.length, 1, "volume-set issues one exec");
t.equal(calls[0].file, "osascript", "macOS volume-set uses osascript");
t.equal(calls[0].args[0], "-e", "volume-set passes its script with -e");
t.ok(calls[0].args[1].startsWith("on run argv") && !calls[0].args[1].includes("40"), "the volume never enters the script source");
t.equal(calls[0].args[2], "40", "the volume travels as its own argv entry");
await mac.control("volume-up", null);
t.deepEqual([calls[1].file, calls[1].args.length, calls[1].args[2]], ["osascript", 3, "6"], "volume-up steps up by argv");
t.ok(calls[1].args[1].includes("if v > 100 then set v to 100"), "volume-up clamps at 100");
await mac.control("volume-down", null);
t.deepEqual([calls[2].file, calls[2].args[2]], ["osascript", "-6"], "volume-down steps down by argv");
t.equal(calls[2].args[1], calls[1].args[1], "volume up and down share one fixed script");
await mac.control("mute-toggle", null);
t.deepEqual(calls[3], { file: "osascript", args: ["-e", "set volume output muted (not output muted of (get volume settings))"] }, "mute toggles the output mute");
await mac.control("sleep", null);
t.deepEqual(calls[4], { file: "pmset", args: ["sleepnow"] }, "sleep uses pmset sleepnow");
await t.rejects(() => mac.control("nope", null), "macOS control rejects an unknown verb");
await t.rejects(() => mac.control("volume-set", 999), "macOS control rejects an out-of-range value");
await t.rejects(() => mac.control("brightness-set", 50), "macOS control rejects the removed brightness-set verb");
await t.rejects(() => mac.control("mute-toggle", 3), "macOS control rejects a stray value");
t.equal(calls.length, 5, "no exec is issued for rejected control input");

// Lock: a real lock through the windows helper first, display sleep as the fallback.
({ calls, provider: mac } = macRecorder((file) => (file === WINDOWS_HELPER ? '{"ok":false}' : "")));
await mac.control("lock", null);
t.deepEqual(calls.map((c) => [c.file, ...c.args]), [[WINDOWS_HELPER, "lock"], ["pmset", "displaysleepnow"]],
  "lock falls back to pmset displaysleepnow when the helper reports ok:false");
({ calls, provider: mac } = macRecorder((file) => (file === WINDOWS_HELPER ? '{"ok":true}' : "")));
await mac.control("lock", null);
t.deepEqual(calls.map((c) => [c.file, ...c.args]), [[WINDOWS_HELPER, "lock"]], "a successful helper lock does not also sleep the display");
({ calls, provider: mac } = macRecorder((file) => { if (file === WINDOWS_HELPER) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); return ""; }));
await mac.control("lock", null);
t.deepEqual(calls.at(-1), { file: "pmset", args: ["displaysleepnow"] }, "a missing helper still locks by sleeping the display");

// Shutdown / restart: stop windows reopening at login first, then ask System Events.
for (const [verb, action] of [["shutdown", "shut down"], ["restart", "restart"]]) {
  ({ calls, provider: mac } = macRecorder());
  await mac.control(verb, null);
  t.equal(calls.length, 2, `${verb} issues exactly two commands`);
  t.deepEqual(calls[0], { file: "defaults", args: ["write", "com.apple.loginwindow", "TALLogoutSavesState", "-bool", "false"] },
    `${verb} first turns off TALLogoutSavesState`);
  t.deepEqual(calls[1], { file: "osascript", args: ["-e", `tell application "System Events" to ${action}`] },
    `${verb} then tells System Events to ${action}`);
  ({ calls, provider: mac } = macRecorder((file) => { if (file === "defaults") throw new Error("defaults failed"); return ""; }));
  await mac.control(verb, null);
  t.equal(calls.at(-1).file, "osascript", `${verb} still proceeds when defaults fails`);
}

// Media verbs drive whatever macOS reports as playing, through its own scripting.
({ calls, provider: mac } = macRecorder());
const idle = await mac.control("media-play-pause", null).then(() => null, (error) => error);
t.equal(idle?.status, 409, "media control with nothing playing is a 409, not a stray media key");
t.ok(!calls.some((c) => osa(c) && c.args[1]?.startsWith("tell application id")), "nothing is told to play when nothing is playing");
({ calls, provider: mac } = macRecorder((file, args) =>
  file === "osascript" && args[0] === "-l" ? JSON.stringify({ bundleId: "com.spotify.client", appName: "Spotify", title: "Song", playing: true }) : ""));
await mac.control("media-next", null);
t.deepEqual(calls.at(-1), { file: "osascript", args: ["-e", 'tell application id "com.spotify.client"\nnext track\nend tell'] },
  "media-next tells the playing player to skip");
mac.dispose();

const linCalls = [];
const lin = createLinuxProvider({
  exec: async (file, args) => {
    linCalls.push({ file, args });
    return { stdout: "" };
  },
});
await lin.control("volume-set", 40);
t.equal(linCalls[0].file, "pactl", "linux volume-set uses pactl");
t.deepEqual(linCalls[0].args, ["set-sink-volume", "@DEFAULT_SINK@", "40%"], "linux volume argv is exact");
await lin.control("media-play-pause", null);
t.equal(linCalls[1].file, "playerctl", "linux media control uses playerctl");
await t.rejects(() => lin.control("nope", null), "linux control rejects an unknown verb");

t.done("control verification passed");
