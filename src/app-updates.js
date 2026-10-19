/**
 * Tablet app updates over Wi-Fi.
 *
 * `npm run android:update` builds a new APK and publishes it to
 * ~/.config/macdoc/updates with a small manifest. Paired devices ask the host
 * for that manifest and download the APK over the same PIN-protected
 * connection the dock uses, so updating never needs a cable.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { settingsDir } from "./host-settings.js";

export function updatesDir() {
  return join(settingsDir(), "updates");
}

export function createAppUpdates({ dir = updatesDir() } = {}) {
  async function latest() {
    try {
      const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
      if (!Number.isInteger(manifest.versionCode) || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") || !/^[\w.-]+\.apk$/.test(manifest.file || "")) return null;
      const info = await stat(join(dir, manifest.file));
      return { available: true, versionCode: manifest.versionCode, versionName: String(manifest.versionName || manifest.versionCode), sha256: manifest.sha256, bytes: info.size, publishedAt: manifest.publishedAt || null, notes: String(manifest.notes || "") };
    } catch {
      return null;
    }
  }
  return {
    latest,
    /** Streams the APK to a response, or returns false when there is none. */
    async send(res) {
      const current = await latest();
      if (!current) return false;
      res.writeHead(200, {
        "content-type": "application/vnd.android.package-archive",
        "content-length": current.bytes,
        "content-disposition": `attachment; filename="MacDoc-${current.versionName.replace(/[^\w.-]/g, "_")}.apk"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
      createReadStream(join(dir, manifest.file)).pipe(res);
      return true;
    },
  };
}
