/**
 * Test fixtures for the macOS provider: fake .app bundles on disk and an
 * injected `exec` that records every call instead of running anything.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleName</key><string>Fake</string></dict></plist>
`;

/** Create `<root>/<rel>` as an app bundle, with Contents/Info.plist unless `plist` is false. */
export async function makeApp(root, rel, { plist = true } = {}) {
  const bundle = join(root, rel);
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  if (plist) await writeFile(join(bundle, "Contents", "Info.plist"), PLIST);
  return bundle;
}

export function tempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * An exec double. `respond(file, args)` may return stdout (string), a full
 * `{ stdout }` object, or throw to simulate a failing command.
 */
export function recorder(respond = () => "") {
  const calls = [];
  return {
    calls,
    exec: async (file, args = []) => {
      calls.push({ file, args: [...args] });
      const out = await respond(file, args);
      return typeof out === "string" || out === undefined ? { stdout: out ?? "", stderr: "" } : out;
    },
  };
}
