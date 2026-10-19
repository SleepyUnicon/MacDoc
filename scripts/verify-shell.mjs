/** The dock page script defines every function it relies on (a removed helper breaks the whole page). */
import { readFile } from "node:fs/promises";
import { createChecker } from "./lib/assert.mjs";

const t = createChecker("shell");
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const declared = new Set([...source.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));

// Functions the page and its modules are handed at start-up; if any is missing the dock never loads.
for (const name of ["api", "notify", "report", "showPair", "showApp", "paint", "refresh", "connect", "syncLayout", "saveLayout", "commitTiles", "openDrawer", "openSettings", "activate"]) {
  t.ok(declared.has(name), `app.js declares ${name}()`);
}
// Every bare identifier passed to a create*({ ... }) factory must be declared somewhere in app.js.
for (const call of source.matchAll(/create\w+\(\{([^}]*)\}\)/g)) {
  for (const part of call[1].split(",")) {
    const name = part.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) t.ok(declared.has(name) || new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(source) || /^(WebSocket|localStorage)$/.test(name), `factory argument ${name} is defined`);
  }
}
t.ok(!/captureAction|paintCapture|\/api\/capture/.test(source), "screen capture code is gone from the dock");
t.done("shell verification passed");
