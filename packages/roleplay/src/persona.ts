import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCard, type ExtractedAsset } from "@character-foundry/character-foundry/loader";
import type { CCv3Data } from "@character-foundry/character-foundry/schemas";
import { normalizeEmotionName } from "./stickers.js";
import { normalizeWorldbook, type WorldbookEntry } from "./worldbook.js";

const PERSONA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CARD_BYTES = 25 * 1024 * 1024;

export interface PersonaRecord {
  id: string;
  name: string;
  dir: string;
  cardPath: string;
  firstMes: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImportCardInput {
  sourcePath: string;
  personasDir: string;
  /** Optional stable id. Defaults to a slug of the card name or a content hash. */
  id?: string;
  now?: number;
  /** Optional plugin dataDir/stickers root for extracted CCv3 emotion assets. */
  stickerRoot?: string;
}

export interface ImportedPersona {
  persona: PersonaRecord;
  card: CCv3Data;
  worldbook: WorldbookEntry[];
  stickerCount: number;
}

function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function fallbackId(buffer: Buffer): string {
  return `persona-${createHash("sha1").update(buffer).digest("hex").slice(0, 8)}`;
}

function assertId(id: string): void {
  if (!PERSONA_ID.test(id)) {
    throw new Error(
      `invalid persona id '${id}': use lowercase letters, digits, dashes or underscores`,
    );
  }
}

export function renderAgentsMd(card: CCv3Data, notes = ""): string {
  const data = card.data;
  const sections: string[] = [`# 角色：${data.name}`];
  const add = (title: string, value: string | null | undefined): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      sections.push(`## ${title}`, value.trim());
    }
  };

  add("基本设定", data.description);
  add("性格", data.personality);
  add("场景", data.scenario);
  add("对话示例", data.mes_example);
  add("角色卡系统提示", data.system_prompt);
  add("历史后置指令", data.post_history_instructions);

  const extra = notes.trim();
  if (extra.length > 0) sections.push("## 用户补充", extra);
  return `${sections.join("\n\n")}\n`;
}

export function renderGreetings(card: CCv3Data): string {
  const data = card.data;
  const lines = ["# 开场白", "", "## 默认", data.first_mes.trim()];
  const alternatives = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  for (const [index, greeting] of alternatives.entries()) {
    lines.push("", `## 备选 ${index + 1}`, greeting.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function renderWorldbookMarkdown(entries: WorldbookEntry[]): string {
  if (entries.length === 0) return "# 世界书\n\n（空）\n";
  const lines = ["# 世界书", ""];
  for (const entry of entries) {
    lines.push(`## ${entry.name}`);
    lines.push(
      `关键词：${entry.keys.length > 0 ? entry.keys.join("、") : "（常驻）"}`,
      `优先级：${entry.priority} · 触发：${entry.constant ? "常驻" : entry.selective ? "主+次关键词" : "关键词"} · 匹配：${entry.matchWholeWords === true ? "整词" : "子串"} · 位置：${entry.position}`,
      "",
      entry.content,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Import a CCv2/V3 card (JSON, PNG, CharX) into a self-contained persona dir. */
export async function importCard(input: ImportCardInput): Promise<ImportedPersona> {
  const buffer = await readFile(input.sourcePath);
  if (buffer.length > MAX_CARD_BYTES) {
    throw new Error(`card is too large (${buffer.length} bytes, max ${MAX_CARD_BYTES})`);
  }
  const parsed = parseCard(buffer);
  const card = parsed.card;
  const id = input.id ?? (slugify(card.data.name) || fallbackId(buffer));
  assertId(id);

  const dir = join(input.personasDir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cardPath = join(dir, "card.json");
  const notesPath = join(dir, "notes.md");
  const now = input.now ?? Date.now();
  const existing = await readPersonaRecord(dir).catch(() => null);

  let notes = "";
  try {
    notes = await readFile(notesPath, "utf8");
  } catch {
    notes = "";
    await writeFile(notesPath, "", { encoding: "utf8", mode: 0o600 });
  }

  const worldbook = normalizeWorldbook(card);
  await Promise.all([
    writeFile(cardPath, `${JSON.stringify(card, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(dir, "AGENTS.md"), renderAgentsMd(card, notes), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(dir, "greetings.md"), renderGreetings(card), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(dir, "worldbook.json"), `${JSON.stringify(worldbook, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(dir, "worldbook.md"), renderWorldbookMarkdown(worldbook), {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);

  const mainAsset = parsed.assets.find((asset) => asset.isMain) ?? parsed.assets[0];
  if (mainAsset !== undefined) {
    const ext = mainAsset.ext.replace(/^\./, "") || "png";
    await writeFile(join(dir, `avatar.${ext}`), Buffer.from(mainAsset.data), { mode: 0o600 });
  }
  const stickerCount =
    input.stickerRoot === undefined
      ? 0
      : await writeEmotionAssets(parsed.assets, id, input.stickerRoot);

  const persona: PersonaRecord = {
    id,
    name: card.data.name,
    dir,
    cardPath,
    firstMes: card.data.first_mes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeFile(join(dir, "persona.json"), `${JSON.stringify(persona, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { persona, card, worldbook, stickerCount };
}

/**
 * Copy CCv3 emotion assets into `<dataDir>/stickers/<persona>/<emotion>/`.
 * Returns the number of written files (0 when the card has no emotion assets).
 */
export async function writeEmotionAssets(
  assets: ExtractedAsset[],
  personaId: string,
  stickerRoot: string,
): Promise<number> {
  let count = 0;
  for (const asset of assets) {
    if (asset.type !== "emotion") continue;
    const emotion = normalizeEmotionName(asset.name);
    if (emotion === null) continue;
    const ext = normalizeImageExtension(asset.ext);
    if (ext === null) continue;
    const dir = join(stickerRoot, personaId, emotion);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const base = sanitizeAssetName(asset.name) || emotion;
    let name = `${base}.${ext}`;
    let suffix = 2;
    while (await exists(join(dir, name))) {
      name = `${base}-${suffix}.${ext}`;
      suffix += 1;
    }
    await writeFile(join(dir, name), Buffer.from(asset.data), { mode: 0o600 });
    count += 1;
  }
  return count;
}

function normalizeImageExtension(value: string): string | null {
  const ext = value.trim().toLowerCase().replace(/^\./, "");
  return ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? ext : null;
}

function sanitizeAssetName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPersonaRecord(dir: string): Promise<PersonaRecord | null> {
  const raw = await readFile(join(dir, "persona.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<PersonaRecord>;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.dir !== "string" ||
    typeof value.cardPath !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    ...value,
    dir,
    cardPath: join(dir, "card.json"),
    firstMes: typeof value.firstMes === "string" ? value.firstMes : "",
  } as PersonaRecord;
}

export async function getPersona(
  personasDir: string,
  id: string,
): Promise<PersonaRecord | null> {
  if (!PERSONA_ID.test(id)) return null;
  return readPersonaRecord(join(personasDir, id)).catch(() => null);
}

export async function listPersonas(personasDir: string): Promise<PersonaRecord[]> {
  const entries = await readdir(personasDir, { withFileTypes: true }).catch(() => []);
  const personas: PersonaRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const persona = await readPersonaRecord(join(personasDir, entry.name)).catch(() => null);
    if (persona !== null) personas.push(persona);
  }
  return personas.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readPersonaCard(dir: string): Promise<CCv3Data | null> {
  const raw = await readFile(join(dir, "card.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const card = JSON.parse(raw) as CCv3Data;
    return card !== null && typeof card === "object" ? card : null;
  } catch {
    return null;
  }
}

export async function readPersonaNotes(dir: string): Promise<string> {
  return readFile(join(dir, "notes.md"), "utf8").catch(() => "");
}

/**
 * Update the user-editable notes and regenerate AGENTS.md while preserving the
 * stable card content. This is the only persona markdown the WebUI edits.
 */
export async function updatePersonaNotes(
  personasDir: string,
  id: string,
  notes: string,
): Promise<PersonaRecord> {
  assertId(id);
  const persona = await getPersona(personasDir, id);
  if (persona === null) throw new Error(`persona not found: ${id}`);
  const card = await readPersonaCard(persona.dir);
  if (card === null) throw new Error(`persona card is missing: ${id}`);
  const normalized = notes.replace(/\r\n/g, "\n").trim();
  await writeFile(join(persona.dir, "notes.md"), normalized, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(persona.dir, "AGENTS.md"), renderAgentsMd(card, normalized), {
    encoding: "utf8",
    mode: 0o600,
  });
  const updated: PersonaRecord = { ...persona, updatedAt: Date.now() };
  await writeFile(join(persona.dir, "persona.json"), `${JSON.stringify(updated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return updated;
}

export async function deletePersona(personasDir: string, id: string): Promise<boolean> {
  assertId(id);
  const dir = join(personasDir, id);
  const exists = await access(dir).then(
    () => true,
    () => false,
  );
  if (!exists) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
