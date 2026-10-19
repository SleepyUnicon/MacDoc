/** G4: launch and focus build exact argv that never reaches a shell. */
import { createChecker } from "./lib/assert.mjs";
import { createMacProvider } from "../src/platform/macos.js";
import { createLinuxProvider, splitExec, parseDesktop } from "../src/platform/linux.js";

const t = createChecker("launch");

function recorder(stdout = "") {
  const calls = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push({ file, args });
      return { stdout };
    },
  };
}
const macWith = (rec) => createMacProvider({ exec: rec.exec, appDirs: [], extraApps: [] });

// ---- macOS launch / focus / close ----
let rec = recorder();
let mac = macWith(rec);

await mac.launchApp({ target: "/Applications/Safari.app" });
t.equal(rec.calls.length, 1, "launch issues exactly one exec");
t.equal(rec.calls[0].file, "open", "launch dispatches to open");
t.deepEqual(rec.calls[0].args, ["-a", "/Applications/Safari.app"], "launch argv is [-a, bundle] with the path as one argument");
await mac.launchApp("/Applications/Notes.app");
t.deepEqual(rec.calls[1].args, ["-a", "/Applications/Notes.app"], "launch also accepts a bare bundle path");

await mac.focusApp({ pid: 812, path: "/Applications/Safari.app" });
t.equal(rec.calls[2].file, "open", "focus dispatches to open");
t.deepEqual(rec.calls[2].args, ["-a", "/Applications/Safari.app"], "focus argv is [-a, bundle] (brings a running app forward)");

await mac.closeApp({ pid: 812, path: "/Applications/Safari.app" });
t.equal(rec.calls[3].file, "osascript", "close dispatches to osascript");
t.equal(rec.calls[3].args.length, 3, "close argv is [-e, script, path]");
t.equal(rec.calls[3].args[0], "-e", "close passes the script with -e");
t.ok(rec.calls[3].args[1].startsWith("on run argv") && rec.calls[3].args[1].includes("item 1 of argv"), "close reads the bundle from argv");
t.ok(!rec.calls[3].args[1].includes("Safari"), "the bundle path is never spliced into the AppleScript source");
t.equal(rec.calls[3].args[2], "/Applications/Safari.app", "the bundle path travels as its own argv entry");

// The decisive property: a hostile path must remain ONE argv entry. If any
// code path joined argv into a string, this target would become a second
// command. Assert both the count and the exact element.
const HOSTILE = '/Applications/a b"; rm -rf ~; echo "pwned.app';
rec = recorder();
mac = macWith(rec);
await mac.launchApp({ target: HOSTILE });
await mac.focusApp({ pid: 5, path: HOSTILE });
await mac.closeApp({ pid: 5, path: HOSTILE });
t.equal(rec.calls[0].args.length, 2, "hostile launch path does not expand into extra argv entries");
t.equal(rec.calls[0].args[1], HOSTILE, "hostile launch path is passed through verbatim as one argument");
t.equal(rec.calls[1].args[1], HOSTILE, "hostile focus path is passed through verbatim as one argument");
t.equal(rec.calls[2].args[2], HOSTILE, "hostile close path is passed through verbatim as one argv entry");
t.ok(!rec.calls[2].args[1].includes("rm -rf"), "the hostile path never enters the AppleScript source");
t.ok(
  !rec.calls.some(({ args }) => args.some((a) => a === "rm" || a === "-rf" || a === "~;")),
  "no fragment of the hostile path becomes its own argument",
);

// Negative control: prove the assertion above can fail. A deliberately unsafe
// joiner must be caught by the same check, otherwise the check proves nothing.
const unsafeArgv = ["-a", ...HOSTILE.split(" ")];
t.ok(unsafeArgv.length > 2, "negative control: a shell-splitting launcher produces extra argv entries");

// Bad input must reject before any exec happens.
rec = recorder();
mac = macWith(rec);
for (const bad of [{}, { target: "" }, { target: "   " }, { target: null }, null, { target: "/usr/bin/true" }, { target: "/Applications/Safari.app/../../bin/sh" }]) {
  await t.rejects(() => mac.launchApp(bad), `launch rejects invalid target ${JSON.stringify(bad)}`);
}
for (const bad of [{ pid: 4812 }, { path: "" }, { path: "/bin/sh" }, { path: 42 }, {}, null]) {
  await t.rejects(() => mac.focusApp(bad), `focus rejects a non-bundle ${JSON.stringify(bad)}`);
  await t.rejects(() => mac.closeApp(bad), `close rejects a non-bundle ${JSON.stringify(bad)}`);
}
t.equal(rec.calls.length, 0, "no exec is issued for any rejected input");

// ---- Linux provider argv ----
const lrec = recorder();
const lin = createLinuxProvider({ exec: lrec.exec });
await lin.launchApp({ target: "/usr/bin/firefox", argv: ["/usr/bin/firefox", "--new-window"] });
t.equal(lrec.calls[0].file, "/usr/bin/firefox", "linux launch execs the binary directly");
t.deepEqual(lrec.calls[0].args, ["--new-window"], "linux launch passes remaining argv");

t.deepEqual(splitExec("/usr/bin/app %U"), ["/usr/bin/app"], "field codes are stripped from Exec");
t.deepEqual(
  splitExec('"/opt/my app/run" --flag "a b"'),
  ["/opt/my app/run", "--flag", "a b"],
  "quoted Exec segments stay single arguments",
);
t.deepEqual(splitExec(""), [], "empty Exec yields no argv");

const entry = parseDesktop("[Desktop Entry]\nType=Application\nName=Demo\nExec=/usr/bin/demo %F\n", "demo");
t.equal(entry.name, "Demo", "desktop entry name is parsed");
t.equal(entry.target, "/usr/bin/demo", "desktop entry target is parsed");
t.equal(parseDesktop("[Desktop Entry]\nType=Application\nName=H\nExec=/x\nNoDisplay=true\n", "h"), null,
  "NoDisplay entries are skipped");
t.equal(parseDesktop("[Desktop Entry]\nType=Link\nName=L\nURL=x\n", "l"), null, "non-Application types are skipped");
t.equal(parseDesktop("[Desktop Entry]\nType=Application\nName=NoExec\n", "n"), null, "entries without Exec are skipped");

t.done("launch verification passed");
