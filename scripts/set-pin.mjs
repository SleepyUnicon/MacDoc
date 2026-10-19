#!/usr/bin/env node
// Usage: npm run set-pin -- 1234     (fixed PIN)
//        npm run set-pin -- --random (back to a new PIN each start)
import { savePin } from "../src/host-settings.js";

const value = process.argv[2];
if (value === "--random") {
  console.log(`Fixed PIN removed (${savePin(null)}). MacDoc will make a new PIN each time it starts.`);
} else if (/^\d{4}$/.test(value || "")) {
  console.log(`MacDoc's PIN is now ${value} (saved in ${savePin(value)}). Restart MacDoc; paired devices will need to enter it once.`);
} else {
  console.error("Usage: npm run set-pin -- 1234   or   npm run set-pin -- --random");
  process.exit(1);
}
