import { createHash } from "node:crypto";
import { access, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const THUMBNAIL_WIDTH = 320;

export interface ThumbnailInput {
  sourcePath: string;
  cacheRoot: string;
  /** Namespace used to avoid collisions between personas. */
  key: string;
}

/**
 * Generate (or reuse) a small WebP preview for a sticker. The cache key includes
 * the source mtime and size, so replacing a file invalidates its thumbnail.
 */
export async function ensureStickerThumbnail(input: ThumbnailInput): Promise<string> {
  const info = await stat(input.sourcePath);
  const digest = createHash("sha256")
    .update(input.sourcePath)
    .update(":")
    .update(String(info.mtimeMs))
    .update(":")
    .update(String(info.size))
    .digest("hex")
    .slice(0, 16);
  const targetDir = join(input.cacheRoot, safeKey(input.key));
  const target = join(targetDir, `${basenameWithoutExtension(input.sourcePath)}-${digest}.webp`);
  try {
    await access(target);
    return target;
  } catch {
    // Generate below.
  }
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await sharp(input.sourcePath, { animated: false })
      .rotate()
      .resize({
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_WIDTH,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toFile(temporary);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return target;
}

function basenameWithoutExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "sticker";
  const index = name.lastIndexOf(".");
  return sanitizeKey(index > 0 ? name.slice(0, index) : name);
}

function safeKey(value: string): string {
  return sanitizeKey(value) || "sticker";
}

function sanitizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
