/** G3: running-app enumeration on macOS yields stable app identities. */
import { createChecker } from "./lib/assert.mjs";
import { recorder } from "./lib/mac-fixtures.mjs";
import { parseMacPs, parseVmStat, appIdFromBundle, createMacProvider } from "../src/platform/macos.js";

const t = createChecker("running");

const PS = [
  "    1 /sbin/launchd",
  "  812 /Applications/Safari.app/Contents/MacOS/Safari",
  "  120 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
  "  913 /Applications/Safari.app/Contents/MacOS/Safari",
  "  950 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
  "  960 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "  970 /usr/libexec/trustd",
  "    0 /Applications/Zero.app/Contents/MacOS/Zero",
  "garbage line",
  "",
  " 1001 /Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
].join("\n");

const running = parseMacPs(PS);
const pids = running.map((r) => r.pid);

t.deepEqual(pids, [120, 812, 960, 1001], "exactly the top-level app bundles survive, sorted by pid");
t.ok(!pids.includes(1) && !pids.includes(970), "non-bundle daemons are excluded");
t.ok(!pids.includes(950), "helpers nested inside another bundle are excluded");
t.ok(!pids.includes(913), "a second process of the same app collapses to the first");
t.ok(!pids.includes(0), "pid 0 is excluded");

const safari = running.find((r) => r.pid === 812);
t.equal(safari.path, "/Applications/Safari.app", "path is the bundle, not the inner executable");
t.equal(safari.name, "Safari", "name is the bundle name");
t.equal(safari.id, appIdFromBundle("/Applications/Safari.app"), "running id matches the installed id for the same bundle");
const code = running.find((r) => r.pid === 960);
t.equal(code.name, "Visual Studio Code", "the bundle name wins over the executable name (Electron)");
t.ok(running.every((r) => r.title === "" && r.handle === 0), "macOS records carry no window title or handle");

for (const bad of ["", "not ps output", null, undefined, "abc /Applications/X.app/Contents/MacOS/X"]) {
  const out = parseMacPs(bad);
  t.ok(Array.isArray(out) && out.length === 0, `malformed ps output yields an empty array: ${JSON.stringify(bad)}`);
}
t.ok(parseMacPs(PS).length > 0, "negative control: valid ps output is not empty");

// ---- the provider issues the constant ps argv ----
const rec = recorder(() => PS);
const mac = createMacProvider({ exec: rec.exec, appDirs: [], extraApps: [] });
const viaProvider = await mac.listRunningApps();
t.equal(viaProvider.length, 4, "provider returns parsed running apps");
t.equal(rec.calls[0].file, "ps", "provider invokes ps");
t.deepEqual(rec.calls[0].args, ["-axo", "pid=,comm="], "provider passes constant ps arguments");

// ---- memory as Activity Monitor counts it ----
const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Anonymous pages:                         600000.
Pages purgeable:                         100000.
Pages wired down:                        150000.
Pages occupied by compressor:             50000.
`;
const total = 16384 * 1_000_000;
t.equal(parseVmStat(VM, total), 70, "memory = app + wired + compressed pages over total");
t.equal(parseVmStat("", total), null, "absent vm_stat degrades to null rather than NaN");
t.equal(parseVmStat(VM, 0), null, "an unknown total degrades to null");
t.equal(parseVmStat(VM, 1), 100, "memory is clamped to 100");

const stats = createMacProvider({
  appDirs: [],
  extraApps: [],
  exec: async (file) => {
    if (file === "pmset") return { stdout: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t88%; charging; 0:40 remaining" };
    if (file === "vm_stat") return { stdout: VM };
    return { stdout: "" };
  },
});
const s = await stats.systemStats();
t.equal(s.battery, 88, "battery percentage is read from pmset");
t.equal(s.charging, true, "charging flag is read from pmset");
t.ok(s.memory === null || (Number.isInteger(s.memory) && s.memory >= 0 && s.memory <= 100), "memory is a bounded percentage");
const desktop = createMacProvider({ appDirs: [], extraApps: [], exec: async (file) => { if (file === "pmset") throw new Error("no battery"); return { stdout: "" }; } });
const ds = await desktop.systemStats();
t.equal(ds.battery, null, "a Mac without a battery reports null");
t.equal(ds.charging, null, "a Mac without a battery reports no charging state");

for (const p of [mac, stats, desktop]) p.dispose();
t.done("running verification passed");
