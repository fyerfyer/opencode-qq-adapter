import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { ensureStickerThumbnail } from "./thumbnails.js";

export const STICKER_MAX_BYTES = 20 * 1024 * 1024;
export const STICKER_EMOTION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const STICKER_PERSONA = /^(?:_global|[a-z0-9][a-z0-9_-]{0,63})$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface StickerFileInfo {
  name: string;
  size: number;
  updatedAt: number;
}

export interface StickerSet {
  persona: Map<string, StickerFileInfo[]>;
  global: Map<string, StickerFileInfo[]>;
}

export interface StickerUpload {
  name: string;
  data: Uint8Array;
}

export interface StickerUploadResult {
  uploaded: StickerFileInfo[];
  duplicates: number;
  rejected: Array<{ name: string; reason: string }>;
}

/** Scan one persona and the global fallback without merging them. */
export async function scanStickerSet(root: string, persona: string): Promise<StickerSet> {
  assertPersona(persona);
  return {
    persona: await scanStickerRoot(join(root, persona)),
    global: await scanStickerRoot(join(root, "_global")),
  };
}

export async function saveStickerFiles(input: {
  root: string;
  persona: string;
  emotion: string;
  files: StickerUpload[];
}): Promise<StickerUploadResult> {
  assertPersona(input.persona);
  assertEmotion(input.emotion);
  const dir = join(input.root, input.persona, input.emotion);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await hashesIn(dir);
  const uploaded: StickerFileInfo[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  let duplicates = 0;

  for (const file of input.files) {
    const mime = detectImageMime(file.data);
    if (mime === null) {
      rejected.push({ name: file.name, reason: "unsupported image type" });
      continue;
    }
    if (file.data.byteLength === 0 || file.data.byteLength > STICKER_MAX_BYTES) {
      rejected.push({ name: file.name, reason: "file is empty or too large" });
      continue;
    }
    const hash = createHash("sha256").update(file.data).digest("hex");
    if (existing.has(hash)) {
      duplicates += 1;
      continue;
    }
    const ext = extensionForMime(mime);
    const base = sanitizeStickerName(file.name) || input.emotion;
    const name = `${base}-${hash.slice(0, 10)}${ext}`;
    const target = join(dir, name);
    await writeFile(target, file.data, { mode: 0o600 });
    existing.add(hash);
    const info = await stat(target);
    uploaded.push({ name, size: info.size, updatedAt: info.mtimeMs });
  }

  return { uploaded, duplicates, rejected };
}

export async function deleteStickerFile(input: {
  root: string;
  persona: string;
  emotion: string;
  name: string;
}): Promise<boolean> {
  const path = await resolveStickerPath(input);
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function renameStickerEmotion(input: {
  root: string;
  persona: string;
  emotion: string;
  nextEmotion: string;
}): Promise<boolean> {
  assertPersona(input.persona);
  assertEmotion(input.emotion);
  assertEmotion(input.nextEmotion);
  const root = await realpath(input.root).catch(() => input.root);
  const current = await resolveInside(root, join(root, input.persona, input.emotion));
  const target = join(root, input.persona, input.nextEmotion);
  if (relative(root, target).startsWith(`..${sep}`)) throw new Error("invalid emotion path");
  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`emotion already exists: ${input.nextEmotion}`);
  await rename(current, target);
  return true;
}

export async function readSticker(input: {
  root: string;
  persona: string;
  emotion: string;
  name: string;
}): Promise<{ data: Buffer; mime: string }> {
  const path = await resolveStickerPath(input);
  const data = await readFile(path);
  const mime = detectImageMime(data);
  if (mime === null) throw new Error("unsupported sticker image type");
  return { data, mime };
}

export async function readStickerThumbnail(input: {
  root: string;
  persona: string;
  emotion: string;
  name: string;
}): Promise<{ data: Buffer; mime: "image/webp" }> {
  const path = await resolveStickerPath(input);
  const thumbnail = await ensureStickerThumbnail({
    sourcePath: path,
    cacheRoot: join(input.root, ".thumbnails"),
    key: `${input.persona}/${input.emotion}`,
  });
  return { data: await readFile(thumbnail), mime: "image/webp" };
}

export async function resolveStickerPath(input: {
  root: string;
  persona: string;
  emotion: string;
  name: string;
}): Promise<string> {
  assertPersona(input.persona);
  assertEmotion(input.emotion);
  const name = basename(input.name);
  if (name !== input.name || !IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) {
    throw new Error("invalid sticker file name");
  }
  const root = await realpath(input.root);
  const path = await resolveInside(root, join(root, input.persona, input.emotion, name));
  return path;
}

export function detectImageMime(data: Uint8Array): string | null {
  if (data.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => data[index] === byte)) return "image/png";
    if (String.fromCharCode(...data.subarray(0, 3)) === "GIF") return "image/gif";
    if (
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff
    ) {
      return "image/jpeg";
    }
    const head = String.fromCharCode(...data.subarray(0, 4));
    if (head === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") {
      return "image/webp";
    }
  }
  return null;
}

export function extensionForMime(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  throw new Error(`unsupported image mime: ${mime}`);
}

function assertEmotion(emotion: string): void {
  if (!STICKER_EMOTION.test(emotion)) throw new Error(`invalid emotion: ${emotion}`);
}

function assertPersona(persona: string): void {
  if (!STICKER_PERSONA.test(persona)) throw new Error(`invalid persona: ${persona}`);
}

async function scanStickerRoot(root: string): Promise<Map<string, StickerFileInfo[]>> {
  const result = new Map<string, StickerFileInfo[]>();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const emotion = entry.name.toLowerCase();
    if (!STICKER_EMOTION.test(emotion)) continue;
    const files = await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => []);
    const images: StickerFileInfo[] = [];
    for (const file of files) {
      if (!file.isFile() || !IMAGE_EXTENSIONS.has(extname(file.name).toLowerCase())) continue;
      const info = await stat(join(root, entry.name, file.name)).catch(() => null);
      if (info !== null) {
        images.push({ name: file.name, size: info.size, updatedAt: info.mtimeMs });
      }
    }
    if (images.length > 0) {
      result.set(
        emotion,
        images.sort((left, right) => left.name.localeCompare(right.name)),
      );
    }
  }
  return result;
}

async function hashesIn(dir: string): Promise<Set<string>> {
  const result = new Set<string>();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const data = await readFile(join(dir, entry.name)).catch(() => null);
    if (data !== null) result.add(createHash("sha256").update(data).digest("hex"));
  }
  return result;
}

async function resolveInside(root: string, target: string): Promise<string> {
  const resolved = await realpath(target).catch(() => target);
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("sticker path escapes the sticker root");
  }
  return resolved;
}

function sanitizeStickerName(value: string): string {
  return basename(value)
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}
