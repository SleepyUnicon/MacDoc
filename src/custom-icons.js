/**
 * Custom tile icons uploaded from the setup page.
 *
 * Images live in ~/.config/macdoc/icons, named by their SHA-256, so a tile only
 * stores that name and the same image is kept once. Only PNG, JPEG and WebP
 * are accepted, recognised by their bytes rather than by any name or type the
 * browser claims.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsDir } from "./host-settings.js";

export const ICON_MAX_BYTES = 1024 * 1024;

export function imageType(data) {
  if (data.length > 8 && data[0] === 0x89 && data.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function createIconStore({ dir = join(settingsDir(), "icons") } = {}) {
  return {
    async save(base64) {
      if (typeof base64 !== "string" || !base64) throw Object.assign(new Error("image data is required"), { status: 400 });
      const data = Buffer.from(base64.replace(/^data:image\/[a-z]+;base64,/, ""), "base64");
      if (!data.length || data.length > ICON_MAX_BYTES) throw Object.assign(new Error("Icons must be 1 MB or smaller."), { status: 413 });
      if (!imageType(data)) throw Object.assign(new Error("Use a PNG, JPEG or WebP image."), { status: 415 });
      const hash = createHash("sha256").update(data).digest("hex");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, hash);
      await writeFile(file + ".tmp", data, { mode: 0o600 });
      await rename(file + ".tmp", file);
      return hash;
    },
    async read(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash || "")) return null;
      try {
        const data = await readFile(join(dir, hash));
        const type = imageType(data);
        return type ? { type, data } : null;
      } catch {
        return null;
      }
    },
  };
}
