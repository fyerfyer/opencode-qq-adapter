import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

const EMOTION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TAG_PATTERN = /\[emotion:\s*([^\]]{1,40})\s*\]/gi;

export interface StickerCatalog {
  /** emotion -> paths relative to the plugin data directory. */
  emotions: Map<string, string[]>;
}

export interface EmotionTagResult {
  text: string;
  emotion: string | null;
}

/**
 * Strip every valid-looking emotion tag so it never reaches QQ or memory.
 * The last tag wins when the model emits more than one.
 */
export function extractEmotionTag(input: string): EmotionTagResult {
  let last: string | null = null;
  const text = input.replace(TAG_PATTERN, (_match, raw: string) => {
    const normalized = raw.trim().toLowerCase();
    if (EMOTION_NAME.test(normalized)) last = normalized;
    return "";
  });
  return {
    text: text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    emotion: last,
  };
}

/**
 * Scan `dataDir/stickers/<persona>/<emotion>/` and the shared
 * `dataDir/stickers/_global/<emotion>/` fallback. Persona assets win for the
 * same emotion, so one character can override the global set.
 */
export async function loadStickerCatalog(
  root: string,
  personaId: string,
): Promise<StickerCatalog> {
  const global = await scanRoot(join(root, "_global"), "_global");
  const persona = await scanRoot(join(root, personaId), personaId);
  const emotions = new Map<string, string[]>(global);
  for (const [emotion, files] of persona) {
    emotions.set(emotion, files);
  }
  return { emotions };
}

export function listEmotions(catalog: StickerCatalog): string[] {
  return [...catalog.emotions.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([emotion]) => emotion)
    .sort((left, right) => left.localeCompare(right));
}

export function stickerCount(catalog: StickerCatalog): number {
  let total = 0;
  for (const files of catalog.emotions.values()) total += files.length;
  return total;
}

/** Pick one sticker, avoiding the last file for this chat/persona when possible. */
export function chooseSticker(
  catalog: StickerCatalog,
  emotion: string,
  key: string,
  last: Map<string, string>,
  random: () => number = Math.random,
): string | null {
  const files = catalog.emotions.get(emotion);
  if (files === undefined || files.length === 0) return null;
  const previous = last.get(key);
  const candidates =
    files.length > 1 && previous !== undefined
      ? files.filter((file) => file !== previous)
      : files;
  const pool = candidates.length > 0 ? candidates : files;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  const selected = pool[index] ?? files[0] ?? null;
  if (selected !== null) last.set(key, selected);
  return selected;
}

async function scanRoot(root: string, prefix: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const emotion = entry.name.toLowerCase();
    if (!EMOTION_NAME.test(emotion)) continue;
    const dir = join(root, entry.name);
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const images = files
      .filter((file) => file.isFile() && isImageName(file.name))
      .map((file) => `stickers/${prefix}/${emotion}/${file.name}`.split(sep).join("/"))
      .sort((left, right) => left.localeCompare(right));
    if (images.length > 0) result.set(emotion, images);
  }
  return result;
}

function isImageName(name: string): boolean {
  const index = name.lastIndexOf(".");
  if (index <= 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(index).toLowerCase());
}

/** Normalize a Character Card V3 emotion asset name into a directory name. */
export function normalizeEmotionName(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^emotion[:/_-]?/, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return EMOTION_NAME.test(normalized) ? normalized : null;
}
