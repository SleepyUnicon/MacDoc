#!/usr/bin/env node
// Build the Android app and publish it for the tablet to update itself over Wi-Fi.
//
//   npm run android:update                  next build number, same version name
//   npm run android:update -- --name 0.6.0  also set the version name
//   npm run android:update -- --notes "Window previews"
//
// The APK is signed with this Mac's debug key, the same key as the installed
// app, so Android accepts it as an update. Output: ~/.config/macdoc/updates.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { updatesDir } from "../src/app-updates.js";

const root = resolve(import.meta.dirname, "..");
const android = join(root, "android");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const dir = updatesDir();
mkdirSync(dir, { recursive: true, mode: 0o700 });
let previous = 6;
try { previous = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).versionCode || previous; } catch { /* first publish */ }
const gradleDefault = Number(readFileSync(join(android, "app/build.gradle"), "utf8").match(/macdocVersionCode'\) \?: '(\d+)'/)?.[1] || 6);
const versionCode = Math.max(previous, gradleDefault) + 1;
const versionName = option("--name") || readFileSync(join(android, "app/build.gradle"), "utf8").match(/macdocVersionName'\) \?: '([^']+)'/)?.[1] || "0.4.1";

const env = { ...process.env };
if (!env.JAVA_HOME) {
  for (const home of ["/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home", "/Applications/Android Studio.app/Contents/jbr/Contents/Home"]) {
    if (existsSync(join(home, "bin/java"))) { env.JAVA_HOME = home; break; }
  }
}
console.log(`Building MacDoc ${versionName} (build ${versionCode})…`);
execFileSync("./gradlew", ["--no-daemon", "-q", "assembleDebug", `-PmacdocVersionCode=${versionCode}`, `-PmacdocVersionName=${versionName}`], { cwd: android, env, stdio: "inherit" });

const built = join(android, "app/build/outputs/apk/debug/app-debug.apk");
const file = `MacDoc-${versionCode}.apk`;
copyFileSync(built, join(dir, file));
const sha256 = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
const manifest = { versionCode, versionName, file, sha256, publishedAt: new Date().toISOString(), notes: option("--notes") || "" };
writeFileSync(join(dir, "latest.json.tmp"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
renameSync(join(dir, "latest.json.tmp"), join(dir, "latest.json"));
console.log(`Published ${file} (${versionName}, build ${versionCode}) to ${dir}.\nMacDoc on your tablet will offer it the next time it checks (on open, and every 30 minutes).`);
