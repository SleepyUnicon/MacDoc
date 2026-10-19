/** G2: macOS installed-app inventory is read correctly from .app bundles on disk. */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { makeApp, tempRoot, recorder } from "./lib/mac-fixtures.mjs";
import { createMacProvider, appIdFromBundle } from "../src/platform/macos.js";

const t = createChecker("inventory");
const root = await tempRoot("macdoc-inventory-");

try {
  const apps = join(root, "Applications");
  const utilities = join(root, "Utilities");
  const system = join(root, "System");

  const safari = await makeApp(apps, "Safari.app");
  await makeApp(apps, "Safari.app/Contents/Helpers/Safari Helper.app"); // inside a bundle: never walked
  const photoshop = await makeApp(apps, "Adobe Photoshop 2026/Adobe Photoshop 2026.app");
  await makeApp(apps, "Adobe Photoshop 2026/Uninstall Adobe Photoshop 2026.app");
  await makeApp(apps, "Zoom Remover.app");
  await makeApp(apps, "Broken.app", { plist: false });
  await makeApp(apps, ".Hidden.app");
  const ytChrome = await makeApp(apps, "Chrome Apps.localized/YouTube.app");
  const ytEdge = await makeApp(apps, "Edge Apps/YouTube.app");
  await makeApp(apps, "a/b/c/d/TooDeep.app");
  const terminal = await makeApp(utilities, "Terminal.app");
  const finder = await makeApp(system, "Finder.app");

  const rec = recorder();
  const mac = createMacProvider({
    exec: rec.exec,
    appDirs: [apps, utilities, apps, join(root, "does-not-exist")],
    extraApps: [finder, join(root, "Missing.app")],
  });
  const list = await mac.listInstalledApps();
  const names = list.map((a) => a.name);

  // Pin the exact surviving set, not just its size: a count alone would still
  // pass if filtering kept the wrong records.
  t.deepEqual(
    names,
    ["Adobe Photoshop 2026", "Finder", "Safari", "Terminal", "YouTube (Chrome Apps)", "YouTube (Edge Apps)"],
    "exactly the real apps survive, sorted by name",
  );
  t.ok(!names.some((n) => /uninstall|remover/i.test(n)), "uninstallers and removers are skipped");
  t.ok(!names.includes("Broken"), "a bundle without Contents/Info.plist is skipped");
  t.ok(!names.includes("Hidden") && !names.includes(".Hidden"), "dot-prefixed entries are skipped");
  t.ok(!names.includes("Safari Helper"), "apps nested inside another bundle are not listed");
  t.ok(!names.includes("TooDeep"), "the folder walk is depth-limited");
  t.ok(!names.includes("Missing"), "an extra app that is absent on this Mac is skipped");
  t.equal(rec.calls.length, 0, "inventory reads the disk and runs no command");

  const byName = Object.fromEntries(list.map((a) => [a.name, a]));
  t.equal(byName["Adobe Photoshop 2026"].target, photoshop, "an app nested in a vendor folder is found");
  t.equal(byName["YouTube (Chrome Apps)"].target, ytChrome, "same-named apps get their folder (minus .localized) as a label");
  t.equal(byName["YouTube (Edge Apps)"].target, ytEdge, "the second same-named app gets its own folder label");
  t.equal(byName.Terminal.target, terminal, "every configured app folder is searched");
  t.equal(byName.Safari.source, "applications", "folder apps report the applications source");
  t.equal(byName.Finder.source, "system", "extra apps report the system source");
  t.equal(list.filter((a) => a.target === safari).length, 1, "a folder listed twice does not duplicate its apps");
  t.ok(list.every((a) => a.id === appIdFromBundle(a.target)), "every id is derived from its bundle path");
  t.ok(list.every((a) => a.args === "" && a.icon === "" && !("folder" in a)), "records carry no launch args and no internal fields");
  t.equal(new Set(list.map((a) => a.id)).size, list.length, "ids are unique");

  t.equal(appIdFromBundle("/Applications/Safari.app"), "/applications/safari.app", "app id lower-cases the bundle path");
  t.equal(appIdFromBundle(" /Applications/X.app "), appIdFromBundle("/applications/x.app"), "app id is stable across case and padding");
  t.equal(appIdFromBundle(null), "", "a missing path has an empty id");

  // Negative control: with no folders at all the same code must come back empty,
  // proving the list above is not a constant.
  const empty = createMacProvider({ exec: rec.exec, appDirs: [join(root, "nowhere")], extraApps: [] });
  t.deepEqual(await empty.listInstalledApps(), [], "negative control: no folders yields no apps");
  empty.dispose();
  mac.dispose();
} finally {
  await rm(root, { recursive: true, force: true });
}

t.done("inventory verification passed");
