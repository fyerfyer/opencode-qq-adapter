import { readdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  listPersonas,
  readPersonaCard,
  readPersonaNotes as readNotes,
} from "../persona.js";
import { listEmotions, loadStickerCatalog, stickerCount } from "../stickers.js";
import { type StickerFileInfo, scanStickerSet } from "../sticker-files.js";
import { listMemoryScopes } from "./memory-docs.js";
import { requirePersona } from "./persona-access.js";
import type { RoleplayAdminDeps } from "./types.js";

export async function summarize(deps: RoleplayAdminDeps): Promise<Record<string, unknown>> {
  const personas = await listPersonas(deps.personasDir);
  const stickerSummaries = [];
  let stickerTotal = 0;
  for (const persona of personas) {
    const catalog = await deps.stickerCatalogFor(persona.id);
    const total = stickerCount(catalog);
    stickerTotal += total;
    stickerSummaries.push({
      personaId: persona.id,
      count: total,
      emotions: listEmotions(catalog),
    });
  }
  const globalCatalog = await loadStickerCatalog(deps.stickerRoot, "_global");
  const globalTotal = stickerCount(globalCatalog);
  const scopes = [];
  for (const persona of personas) scopes.push(...(await listMemoryScopes(deps, persona.id)));
  return {
    options: deps.options,
    personas: { total: personas.length },
    stickers: {
      total: stickerTotal + globalTotal,
      personas: stickerSummaries,
      global: { count: globalTotal, emotions: listEmotions(globalCatalog) },
    },
    memory: { scopes: scopes.length },
    bindings: { total: deps.bindings.list().length },
    paths: {
      personas: deps.personasDir,
      stickers: deps.stickerRoot,
      memory: deps.memoryRoot,
      database: deps.databasePath,
    },
    jev: {
      judge: deps.options.stickerJudge,
      apiKeyEnv: deps.options.jevApiKeyEnv,
      apiKeyConfigured: (process.env[deps.options.jevApiKeyEnv]?.trim().length ?? 0) > 0,
      configured:
        deps.options.stickerJudge === "off" ||
        deps.options.stickerJudge === "tag" ||
        (process.env[deps.options.jevApiKeyEnv]?.trim().length ?? 0) > 0,
      ready:
        (deps.options.stickerJudge === "jev" || deps.options.stickerJudge === "hybrid") &&
        (process.env[deps.options.jevApiKeyEnv]?.trim().length ?? 0) > 0,
    },
    checks: await diagnostics(deps),
  };
}

export async function diagnostics(deps: RoleplayAdminDeps): Promise<
  Array<{ id: string; ok: boolean; label: string; detail: string }>
> {
  return [
    check("personas", await fileExists(deps.personasDir), "Persona 目录", deps.personasDir),
    check("stickers", await fileExists(deps.stickerRoot), "表情目录", deps.stickerRoot),
    check("memory", await fileExists(deps.memoryRoot), "记忆目录", deps.memoryRoot),
    check(
      "jev",
      deps.options.stickerJudge !== "jev" && deps.options.stickerJudge !== "hybrid"
        ? true
        : (process.env[deps.options.jevApiKeyEnv]?.trim().length ?? 0) > 0,
      "Jev 密钥",
      deps.options.jevApiKeyEnv,
    ),
  ];
}

function check(id: string, ok: boolean, label: string, detail: string) {
  return { id, ok, label, detail };
}

export async function listPersonaSummaries(deps: RoleplayAdminDeps) {
  const personas = await listPersonas(deps.personasDir);
  const bindings = deps.bindings.list();
  return Promise.all(
    personas.map(async (persona) => {
      const card = await readPersonaCard(persona.dir);
      const catalog = await deps.stickerCatalogFor(persona.id);
      const scopes = await listMemoryScopes(deps, persona.id);
      return {
        id: persona.id,
        name: persona.name,
        description: card?.data.description ?? "",
        avatarUrl: (await avatarExists(persona.dir))
          ? `/admin/api/plugins/roleplay/personas/${encodeURIComponent(persona.id)}/avatar`
          : null,
        updatedAt: persona.updatedAt,
        worldbook: (await deps.worldbookFor(persona)).length,
        stickers: stickerCount(catalog),
        emotions: listEmotions(catalog),
        memoryScopes: scopes.length,
        bindings: bindings.filter((binding) => binding.namespace === persona.id).length,
      };
    }),
  );
}

export async function personaDetail(
  deps: RoleplayAdminDeps,
  id: string,
): Promise<Record<string, unknown>> {
  const persona = await requirePersona(deps, id);
  const card = await readPersonaCard(persona.dir);
  const notes = await readNotes(persona.dir);
  const catalog = await deps.stickerCatalogFor(persona.id);
  const scopes = await listMemoryScopes(deps, persona.id);
  const bindings = deps.bindings.list().filter((binding) => binding.namespace === persona.id);
  return {
    persona,
    card: card?.data ?? null,
    notes,
    worldbook: await deps.worldbookFor(persona),
    stickers: {
      total: stickerCount(catalog),
      emotions: listEmotions(catalog),
    },
    memoryScopes: scopes,
    bindings,
  };
}

export async function stickerOverview(deps: RoleplayAdminDeps) {
  const personas = await listPersonas(deps.personasDir);
  const rows = [];
  for (const persona of personas) {
    const catalog = await deps.stickerCatalogFor(persona.id);
    rows.push({
      personaId: persona.id,
      name: persona.name,
      count: stickerCount(catalog),
      emotions: listEmotions(catalog),
    });
  }
  const globalCatalog = await loadStickerCatalog(deps.stickerRoot, "_global");
  return {
    personas: rows,
    global: { count: stickerCount(globalCatalog), emotions: listEmotions(globalCatalog) },
  };
}

export async function stickerList(deps: RoleplayAdminDeps, personaId: string) {
  const set = await scanStickerSet(deps.stickerRoot, personaId);
  return {
    personaId,
    emotions: mapStickerSet(deps, personaId, set.persona),
    global: mapStickerSet(deps, "_global", set.global),
  };
}

export function mapStickerSet(
  deps: RoleplayAdminDeps,
  personaId: string,
  set: Map<string, StickerFileInfo[]>,
) {
  return [...set.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([emotion, files]) => ({
      emotion,
      files: files.map((file) => stickerInfo(deps, personaId, emotion, file)),
    }));
}

export function stickerInfo(
  _deps: RoleplayAdminDeps,
  personaId: string,
  emotion: string,
  file: StickerFileInfo,
) {
  const base = `/admin/api/plugins/roleplay/media/stickers/${encodeURIComponent(personaId)}/${encodeURIComponent(emotion)}/${encodeURIComponent(file.name)}`;
  return {
    ...file,
    url: base,
    thumbnailUrl: `${base}/thumbnail`,
  };
}

export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function avatarExists(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.some(
    (entry) => entry.isFile() && /^avatar\.(png|jpe?g|gif|webp)$/i.test(entry.name),
  );
}

export function mimeForExtension(ext: string): string {
  if (ext.toLowerCase() === ".png") return "image/png";
  if (ext.toLowerCase() === ".gif") return "image/gif";
  if (ext.toLowerCase() === ".webp") return "image/webp";
  return "image/jpeg";
}

export function safeFileName(value: string): string {
  return basename(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}
