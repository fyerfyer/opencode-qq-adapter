import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type {
  PluginAdmin,
  PluginAdminRequestContext,
  PluginAdminResult,
  PluginChat,
  PluginLogger,
  PluginMessages,
} from "@opencode-qq/plugin-sdk";
import { safeMemorySegment } from "@opencode-qq/memory";
import { BindingStore, type BindingRecord } from "./bindings.js";
import { JevEmotionJudge } from "./jev.js";
import {
  MANUAL_SECTION,
  MemoryDocumentStore,
  type MemoryDoc,
  type MemoryDocKind,
  parseDocument,
  SCENE_SECTIONS,
  USER_SECTIONS,
} from "./memory-document.js";
import { MemoryService } from "./memory-service.js";
import {
  deletePersona,
  getPersona,
  importCard,
  listPersonas,
  readPersonaCard,
  readPersonaNotes as readNotes,
  renderWorldbookMarkdown,
  updatePersonaNotes,
  type PersonaRecord,
} from "./persona.js";
import type { RoleplayOptions } from "./options.js";
import {
  chooseSticker,
  listEmotions,
  loadStickerCatalog,
  stickerCount,
  type StickerCatalog,
} from "./stickers.js";
import {
  deleteStickerFile,
  readSticker,
  readStickerThumbnail,
  renameStickerEmotion,
  saveStickerFiles,
  scanStickerSet,
  type StickerFileInfo,
} from "./sticker-files.js";
import { TranscriptStore } from "./transcript.js";
import {
  formatWorldbookTrace,
  isWorldbookEntry,
  parseStoredWorldbook,
  selectWorldbookDetailed,
  type WorldbookEntry,
} from "./worldbook.js";

const PERSONA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MEMORY_SCOPE = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_CARD_BYTES = 25 * 1024 * 1024;

export interface RoleplayAdminDeps {
  options: RoleplayOptions;
  personasDir: string;
  stickerRoot: string;
  memoryRoot: string;
  databasePath: string;
  agentConfigDir: string;
  memory: MemoryService;
  documents: MemoryDocumentStore;
  transcript: TranscriptStore;
  bindings: BindingStore;
  messages: PluginMessages;
  logger: PluginLogger;
  worldbookCache: Map<string, WorldbookEntry[]>;
  stickerCache: Map<string, StickerCatalog>;
  jev: JevEmotionJudge | null;
}

interface MemoryScope {
  scope: string;
  chatKey: string | null;
  kind: "private" | "shared";
  label: string;
  actorQq: number | null;
  docs: Array<{
    kind: MemoryDocKind;
    actorQq: number | null;
    name: string;
    exists: boolean;
    size: number;
    updatedAt: number | null;
  }>;
}

interface MemoryJob {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
  error: string | null;
}

class AdminHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminHttpError";
    this.status = status;
    this.code = code;
  }
}

type AdminHandler = (context: PluginAdminRequestContext) => Promise<unknown> | unknown;

export function registerRoleplayAdmin(admin: PluginAdmin, deps: RoleplayAdminDeps): void {
  const jobs = new Map<string, MemoryJob>();
  const route = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, handler: AdminHandler) => {
    admin.route(method, path, (context) => withAdminErrors(() => handler(context)));
  };

  admin.page({
    id: "roleplay",
    title: "Roleplay",
    kind: "iframe",
    description: "角色卡、世界书、表情包、记忆和聊天绑定",
  });

  route("GET", "/summary", async () => summarize(deps));
  route("GET", "/diagnostics", async () => ({ checks: await diagnostics(deps) }));

  route("GET", "/personas", async () => ({ personas: await listPersonaSummaries(deps) }));
  route("POST", "/personas/import", async (context) => {
    const form = await readForm(context.request);
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AdminHttpError(400, "missing_file", "请上传角色卡文件。");
    }
    if (file.size > MAX_CARD_BYTES) {
      throw new AdminHttpError(413, "card_too_large", "角色卡不能超过 25 MiB。");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dir = join(deps.personasDir, ".imports");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `${randomUUID()}-${safeFileName(file.name) || "card"}`);
    try {
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(temporary, bytes, { mode: 0o600 }),
      );
      const requestedId = form.get("id");
      const id = typeof requestedId === "string" && requestedId.trim().length > 0
        ? requestedId.trim()
        : undefined;
      const result = await importCard({
        sourcePath: temporary,
        personasDir: deps.personasDir,
        ...(id !== undefined ? { id } : {}),
        stickerRoot: deps.stickerRoot,
      });
      deps.worldbookCache.set(result.persona.id, result.worldbook);
      deps.stickerCache.delete(result.persona.id);
      return {
        persona: result.persona,
        worldbook: result.worldbook.length,
        stickerCount: result.stickerCount,
      };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  route("GET", "/personas/:id", async (context) => personaDetail(deps, param(context, "id")));
  route("PUT", "/personas/:id/notes", async (context) => {
    const body = await readJson(context.request);
    const notes = typeof body.notes === "string" ? body.notes : null;
    if (notes === null) throw new AdminHttpError(400, "invalid_notes", "notes 必须是字符串。");
    const persona = await updatePersonaNotes(deps.personasDir, param(context, "id"), notes);
    return { persona, notes };
  });
  route("DELETE", "/personas/:id", async (context) => {
    const persona = await requirePersona(deps, param(context, "id"));
    const referenced = deps.bindings.list().filter((binding) => binding.namespace === persona.id);
    if (referenced.length > 0) {
      throw new AdminHttpError(
        409,
        "persona_in_use",
        `该角色仍被 ${referenced.length} 个会话绑定，请先解除绑定。`,
      );
    }
    const deleteMemory = context.query.get("deleteMemory") === "true";
    const deleteStickers = context.query.get("deleteStickers") === "true";
    const deleted = await deletePersona(deps.personasDir, persona.id);
    if (deleteMemory) {
      await rm(join(deps.memoryRoot, persona.id), { recursive: true, force: true });
    }
    if (deleteStickers) {
      await rm(join(deps.stickerRoot, persona.id), { recursive: true, force: true });
      await rm(join(deps.stickerRoot, ".thumbnails", persona.id), {
        recursive: true,
        force: true,
      });
    }
    deps.worldbookCache.delete(persona.id);
    deps.stickerCache.delete(persona.id);
    return { deleted, memoryDeleted: deleteMemory, stickersDeleted: deleteStickers };
  });
  route("GET", "/personas/:id/avatar", async (context) => {
    const persona = await requirePersona(deps, param(context, "id"));
    const entries = await readdir(persona.dir, { withFileTypes: true }).catch(() => []);
    const avatar = entries.find(
      (entry) => entry.isFile() && /^avatar\.(png|jpe?g|gif|webp)$/i.test(entry.name),
    );
    if (avatar === undefined) throw new AdminHttpError(404, "avatar_not_found", "角色没有头像。");
    const data = await readFile(join(persona.dir, avatar.name));
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": mimeForExtension(extname(avatar.name)),
        "cache-control": "private, max-age=300",
      },
    });
  });
  route("GET", "/personas/:id/worldbook", async (context) => {
    const persona = await requirePersona(deps, param(context, "id"));
    return { entries: await worldbookFor(deps, persona) };
  });
  route("PUT", "/personas/:id/worldbook", async (context) => {
    const persona = await requirePersona(deps, param(context, "id"));
    const body = await readJson(context.request);
    if (!Array.isArray(body.entries) || !body.entries.every(isWorldbookEntry)) {
      throw new AdminHttpError(400, "invalid_worldbook", "世界书条目格式不正确。");
    }
    const entries = body.entries as WorldbookEntry[];
    const dir = persona.dir;
    await import("node:fs/promises").then(({ writeFile }) =>
      Promise.all([
        writeFile(join(dir, "worldbook.json"), `${JSON.stringify(entries, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        }),
        writeFile(join(dir, "worldbook.md"), renderWorldbookMarkdown(entries), {
          encoding: "utf8",
          mode: 0o600,
        }),
      ]),
    );
    deps.worldbookCache.set(persona.id, entries);
    return { entries };
  });
  route("GET", "/personas/:id/worldbook/check", async (context) => {
    const persona = await requirePersona(deps, param(context, "id"));
    const text = context.query.get("text")?.trim() ?? "";
    if (text.length === 0) throw new AdminHttpError(400, "missing_text", "请提供要检查的文本。");
    const recent = deps.transcript.recent(
      persona.id,
      deps.options.worldbookScanDepth,
      persona.id,
    );
    const trace = selectWorldbookDetailed(
      await worldbookFor(deps, persona),
      { currentText: text, recentTexts: recent.map((row) => row.text) },
      {
        scanDepth: deps.options.worldbookScanDepth,
        maxEntries: deps.options.worldbookMaxEntries,
        maxChars: deps.options.worldbookMaxChars,
        recursionSteps: deps.options.worldbookRecursionSteps,
        matchWholeWords: deps.options.worldbookMatchWholeWords,
      },
    );
    return { text: formatWorldbookTrace(persona.name, text, trace), trace };
  });

  route("GET", "/personas/:id/stickers", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    return stickerList(deps, owner.id);
  });
  route("GET", "/stickers", async () => stickerOverview(deps));
  route("POST", "/personas/:id/stickers/:emotion", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    const form = await readForm(context.request);
    const files = form.getAll("files");
    if (files.length === 0) throw new AdminHttpError(400, "missing_files", "请上传至少一张图片。");
    const uploads = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      if (file.size > 20 * 1024 * 1024) {
        throw new AdminHttpError(413, "sticker_too_large", `${file.name} 超过 20 MiB。`);
      }
      uploads.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    }
    if (uploads.length === 0) throw new AdminHttpError(400, "missing_files", "请上传图片文件。");
    const result = await saveStickerFiles({
      root: deps.stickerRoot,
      persona: owner.id,
      emotion: param(context, "emotion"),
      files: uploads,
    });
    deps.stickerCache.delete(owner.id);
    return {
      uploaded: result.uploaded.length,
      duplicates: result.duplicates,
      rejected: result.rejected,
      files: result.uploaded.map((file) => stickerInfo(deps, owner.id, param(context, "emotion"), file)),
    };
  });
  route("PATCH", "/personas/:id/stickers/:emotion", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    const body = await readJson(context.request);
    const emotion = typeof body.emotion === "string" ? body.emotion.trim().toLowerCase() : "";
    if (emotion.length === 0) throw new AdminHttpError(400, "invalid_emotion", "新情绪名不能为空。");
    await renameStickerEmotion({
      root: deps.stickerRoot,
      persona: owner.id,
      emotion: param(context, "emotion"),
      nextEmotion: emotion,
    });
    deps.stickerCache.delete(owner.id);
    return { emotion };
  });
  route("DELETE", "/personas/:id/stickers/:emotion/:file", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    const deleted = await deleteStickerFile({
      root: deps.stickerRoot,
      persona: owner.id,
      emotion: param(context, "emotion"),
      name: param(context, "file"),
    });
    deps.stickerCache.delete(owner.id);
    return { deleted };
  });
  route("GET", "/media/stickers/:persona/:emotion/:file", async (context) => {
    try {
      const image = await readSticker({
        root: deps.stickerRoot,
        persona: param(context, "persona"),
        emotion: param(context, "emotion"),
        name: param(context, "file"),
      });
      return new Response(new Uint8Array(image.data), {
        headers: {
          "content-type": image.mime,
          "cache-control": "private, max-age=3600",
        },
      });
    } catch {
      throw new AdminHttpError(404, "sticker_not_found", "表情文件不存在。");
    }
  });
  route("GET", "/media/stickers/:persona/:emotion/:file/thumbnail", async (context) => {
    try {
      const image = await readStickerThumbnail({
        root: deps.stickerRoot,
        persona: param(context, "persona"),
        emotion: param(context, "emotion"),
        name: param(context, "file"),
      });
      return new Response(new Uint8Array(image.data), {
        headers: {
          "content-type": image.mime,
          "cache-control": "private, max-age=86400, immutable",
        },
      });
    } catch {
      throw new AdminHttpError(404, "sticker_not_found", "表情文件不存在。");
    }
  });
  route("POST", "/test/sticker", async (context) => {
    const body = await readJson(context.request);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const emotion = typeof body.emotion === "string" ? body.emotion : "";
    const catalog = await catalogFor(deps, persona.id);
    const path = chooseSticker(
      catalog,
      emotion,
      `admin-test:${persona.id}:${emotion}`,
      new Map(),
    );
    if (path === null) throw new AdminHttpError(404, "sticker_not_found", "没有该情绪的表情。");
    const chatKey = typeof body.chatKey === "string" ? body.chatKey : null;
    const binding =
      chatKey === null
        ? deps.bindings.list().find((item) => item.namespace === persona.id) ?? null
        : deps.bindings.list().find((item) => item.chatKey === chatKey) ?? null;
    if (binding === null) {
      throw new AdminHttpError(409, "no_binding", "该角色还没有绑定 QQ 会话，请先在 QQ 中启用。");
    }
    const chat = chatFromKey(binding.chatKey);
    if (chat === null) throw new AdminHttpError(409, "invalid_binding", "绑定会话格式不正确。");
    const result = await deps.messages.sendImage(chat, { path, caption: `sticker:${emotion}` });
    return { messageId: result.messageId, path };
  });
  route("POST", "/test/jev", async (context) => {
    if (deps.jev === null) {
      throw new AdminHttpError(503, "jev_disabled", "Jev 未配置，或 sticker_judge 未启用。");
    }
    const body = await readJson(context.request);
    const userText = typeof body.userText === "string" ? body.userText : "";
    const replyText = typeof body.replyText === "string" ? body.replyText : "";
    const emotions = Array.isArray(body.emotions)
      ? body.emotions.filter((item): item is string => typeof item === "string")
      : [];
    const decision = await deps.jev.judge({ userText, replyText, emotions });
    return decision;
  });

  route("GET", "/memory/scopes", async (context) => {
    const persona = await requirePersona(deps, context.query.get("persona") ?? "");
    return { scopes: await listMemoryScopes(deps, persona.id) };
  });
  route("GET", "/memory/document", async (context) => {
    const { persona, ref, kind, actorQq } = await memoryTarget(deps, context);
    const doc = await readMemoryDoc(deps, persona.id, ref.scope, kind, actorQq);
    return { document: doc, history: await memoryHistory(deps, persona.id, ref.scope, kind, actorQq) };
  });
  route("PUT", "/memory/document", async (context) => {
    const body = await readJson(context.request);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const scope = String(body.scope ?? "");
    const kind = body.kind === "scene" ? "scene" : "user";
    const actorQq = Number(body.actorQq ?? 0);
    const content = typeof body.content === "string" ? body.content : null;
    if (content === null) throw new AdminHttpError(400, "invalid_content", "content 必须是字符串。");
    if (!Number.isSafeInteger(actorQq) || actorQq < 0) {
      throw new AdminHttpError(400, "invalid_actor", "actorQq 不合法。");
    }
    const document = await writeMemoryDoc(deps, {
      personaId: persona.id,
      scope,
      actorQq,
      kind,
      content,
      allowManual: body.allowManual === true,
    });
    return {
      document,
      history: await memoryHistory(deps, persona.id, scope, kind, actorQq),
    };
  });
  route("GET", "/memory/history", async (context) => {
    const { persona, ref, kind, actorQq } = await memoryTarget(deps, context);
    return { history: await memoryHistory(deps, persona.id, ref.scope, kind, actorQq) };
  });
  route("GET", "/memory/history/file", async (context) => {
    const path = context.query.get("path") ?? "";
    const content = await readMemoryHistory(deps, path);
    return { content };
  });
  route("POST", "/memory/history/restore", async (context) => {
    const body = await readJson(context.request);
    const path = typeof body.path === "string" ? body.path : "";
    const content = await readMemoryHistory(deps, path);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const scope = String(body.scope ?? "");
    const kind = body.kind === "scene" ? "scene" : "user";
    const actorQq = Number(body.actorQq ?? 0);
    const document = await writeMemoryDoc(deps, {
      personaId: persona.id,
      scope,
      actorQq,
      kind,
      content,
      allowManual: true,
    });
    return { document };
  });
  route("GET", "/memory/search", async (context) => {
    const { persona, ref, actorQq } = await memoryTarget(deps, context);
    const query = context.query.get("q")?.trim() ?? "";
    if (query.length === 0) return { docs: [], messages: [] };
    return deps.memory.search({
      personaId: persona.id,
      scope: ref.scope,
      actorQq,
      query,
      allActors: true,
      limit: 10,
    });
  });
  route("POST", "/memory/refresh", async (context) => {
    const body = await readJson(context.request);
    const persona = await requirePersona(deps, String(body.persona ?? ""));
    const scope = String(body.scope ?? "");
    const actorQq = Number(body.actorQq ?? parseActorFromScope(scope) ?? 0);
    const chatKey = deps.bindings
      .list()
      .find((binding) => safeMemorySegment(binding.chatKey) === scope)?.chatKey;
    if (chatKey === undefined) {
      throw new AdminHttpError(409, "no_binding", "该 scope 还没有对应的 QQ 会话绑定。");
    }
    const job: MemoryJob = {
      id: randomUUID(),
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
    };
    jobs.set(job.id, job);
    void deps.memory
      .refresh({
        personaId: persona.id,
        personaName: persona.name,
        chatKey,
        scope,
        actorQq,
        senderName: "管理员",
      })
      .then((result) => {
        job.status = result.failed ? "failed" : "completed";
        job.result = result;
        job.finishedAt = Date.now();
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = Date.now();
      });
    return { job };
  });
  route("GET", "/memory/jobs/:id", async (context) => {
    const job = jobs.get(param(context, "id"));
    if (job === undefined) throw new AdminHttpError(404, "job_not_found", "任务不存在。");
    return { job };
  });
  route("DELETE", "/memory/scope", async (context) => {
    const { persona, ref, actorQq } = await memoryTarget(deps, context);
    const deleted = await deps.memory.forgetAll({
      personaId: persona.id,
      scope: ref.scope,
      actorQq,
    });
    return { deleted: true, ...deleted };
  });

  route("GET", "/bindings", async () => {
    return {
      bindings: deps.bindings.list().map((binding) => ({
        ...binding,
        personaId: binding.namespace,
        personaName: binding.namespace,
      })),
    };
  });
  route("PATCH", "/bindings", async (context) => {
    const chatKey = context.query.get("chatKey") ?? "";
    const body = await readJson(context.request);
    if (typeof body.enabled !== "boolean") {
      throw new AdminHttpError(400, "invalid_enabled", "enabled 必须是布尔值。");
    }
    const binding = deps.bindings.setEnabled(chatKey, body.enabled);
    if (binding === null) throw new AdminHttpError(404, "binding_not_found", "绑定不存在。");
    return { binding };
  });
  route("DELETE", "/bindings", async (context) => {
    const chatKey = context.query.get("chatKey") ?? "";
    const deleted = deps.bindings.remove(chatKey);
    return { deleted };
  });
}

async function summarize(deps: RoleplayAdminDeps): Promise<Record<string, unknown>> {
  const personas = await listPersonas(deps.personasDir);
  const stickerSummaries = [];
  let stickerTotal = 0;
  for (const persona of personas) {
    const catalog = await catalogFor(deps, persona.id);
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
      agents: deps.agentConfigDir,
    },
    agents: {
      persona: await fileExists(join(deps.agentConfigDir, "agents", "qq-rp.md")),
      utility: await fileExists(join(deps.agentConfigDir, "agents", "qq-rp-utility.md")),
    },
    jev: {
      judge: deps.options.stickerJudge,
      configured:
        deps.options.stickerJudge === "off" ||
        deps.options.stickerJudge === "tag" ||
        (process.env[deps.options.jevApiKeyEnv]?.trim().length ?? 0) > 0,
    },
    checks: await diagnostics(deps),
  };
}

async function diagnostics(deps: RoleplayAdminDeps): Promise<
  Array<{ id: string; ok: boolean; label: string; detail: string }>
> {
  const agentsDir = join(deps.agentConfigDir, "agents");
  return [
    check("personas", await fileExists(deps.personasDir), "Persona 目录", deps.personasDir),
    check("stickers", await fileExists(deps.stickerRoot), "表情目录", deps.stickerRoot),
    check("memory", await fileExists(deps.memoryRoot), "记忆目录", deps.memoryRoot),
    check(
      "agent",
      await fileExists(join(agentsDir, "qq-rp.md")),
      "qq-rp agent",
      join(agentsDir, "qq-rp.md"),
    ),
    check(
      "utility-agent",
      await fileExists(join(agentsDir, "qq-rp-utility.md")),
      "记忆整理 agent",
      join(agentsDir, "qq-rp-utility.md"),
    ),
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

async function listPersonaSummaries(deps: RoleplayAdminDeps) {
  const personas = await listPersonas(deps.personasDir);
  const bindings = deps.bindings.list();
  return Promise.all(
    personas.map(async (persona) => {
      const card = await readPersonaCard(persona.dir);
      const catalog = await catalogFor(deps, persona.id);
      const scopes = await listMemoryScopes(deps, persona.id);
      return {
        id: persona.id,
        name: persona.name,
        description: card?.data.description ?? "",
        avatarUrl:
          (await avatarExists(persona.dir))
            ? `/admin/api/plugins/roleplay/personas/${encodeURIComponent(persona.id)}/avatar`
            : null,
        updatedAt: persona.updatedAt,
        worldbook: (await worldbookFor(deps, persona)).length,
        stickers: stickerCount(catalog),
        emotions: listEmotions(catalog),
        memoryScopes: scopes.length,
        bindings: bindings.filter((binding) => binding.namespace === persona.id).length,
      };
    }),
  );
}

async function personaDetail(deps: RoleplayAdminDeps, id: string) {
  const persona = await requirePersona(deps, id);
  const card = await readPersonaCard(persona.dir);
  const notes = await readNotes(persona.dir);
  const catalog = await catalogFor(deps, persona.id);
  const scopes = await listMemoryScopes(deps, persona.id);
  const bindings = deps.bindings.list().filter((binding) => binding.namespace === persona.id);
  return {
    persona,
    card: card?.data ?? null,
    notes,
    worldbook: await worldbookFor(deps, persona),
    stickers: {
      total: stickerCount(catalog),
      emotions: listEmotions(catalog),
    },
    memoryScopes: scopes,
    bindings,
  };
}

async function stickerOverview(deps: RoleplayAdminDeps) {
  const personas = await listPersonas(deps.personasDir);
  const rows = [];
  for (const persona of personas) {
    const catalog = await catalogFor(deps, persona.id);
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

async function stickerList(deps: RoleplayAdminDeps, personaId: string) {
  const set = await scanStickerSet(deps.stickerRoot, personaId);
  return {
    personaId,
    emotions: mapStickerSet(deps, personaId, set.persona),
    global: mapStickerSet(deps, "_global", set.global),
  };
}

function mapStickerSet(
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

function stickerInfo(
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

async function worldbookFor(
  deps: RoleplayAdminDeps,
  persona: PersonaRecord,
): Promise<WorldbookEntry[]> {
  const cached = deps.worldbookCache.get(persona.id);
  if (cached !== undefined) return cached;
  const raw = await readFile(join(persona.dir, "worldbook.json"), "utf8").catch(() => null);
  if (raw === null) {
    deps.worldbookCache.set(persona.id, []);
    return [];
  }
  try {
    const entries = parseStoredWorldbook(JSON.parse(raw) as unknown);
    deps.worldbookCache.set(persona.id, entries);
    return entries;
  } catch {
    deps.worldbookCache.set(persona.id, []);
    return [];
  }
}

async function catalogFor(deps: RoleplayAdminDeps, personaId: string): Promise<StickerCatalog> {
  const cached = deps.stickerCache.get(personaId);
  if (cached !== undefined) return cached;
  const catalog = await loadStickerCatalog(deps.stickerRoot, personaId);
  deps.stickerCache.set(personaId, catalog);
  return catalog;
}

async function requirePersona(deps: RoleplayAdminDeps, id: string): Promise<PersonaRecord> {
  if (!PERSONA_ID.test(id)) throw new AdminHttpError(400, "invalid_persona", "角色 ID 不合法。");
  const persona = await getPersona(deps.personasDir, id);
  if (persona === null) throw new AdminHttpError(404, "persona_not_found", "角色不存在。");
  return persona;
}

async function stickerOwner(
  deps: RoleplayAdminDeps,
  id: string,
): Promise<{ id: string }> {
  if (id === "_global") return { id };
  const persona = await requirePersona(deps, id);
  return { id: persona.id };
}

async function listMemoryScopes(
  deps: RoleplayAdminDeps,
  personaId: string,
): Promise<MemoryScope[]> {
  const root = join(deps.memoryRoot, personaId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const bindings = deps.bindings.list();
  const result: MemoryScope[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !MEMORY_SCOPE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    const scenePath = join(dir, "scene.md");
    const userPath = join(dir, "memory.md");
    const scene = await fileStat(scenePath);
    const user = await fileStat(userPath);
    if (scene === null && user === null) continue;
    const binding = bindings.find(
      (item) => safeMemorySegment(item.chatKey) === entry.name,
    );
    const actorQq = parseActorFromScope(entry.name);
    const shared = scene !== null;
    const docs: MemoryScope["docs"] = [];
    if (shared) {
      docs.push(memoryDocInfo("scene", null, scenePath, scene));
      const users = await readdir(join(dir, "users"), { withFileTypes: true }).catch(() => []);
      for (const file of users) {
        if (!file.isFile() || !/^\d{5,12}\.md$/.test(file.name)) continue;
        const path = join(dir, "users", file.name);
        const info = await fileStat(path);
        if (info !== null) {
          docs.push(memoryDocInfo("user", Number(file.name.slice(0, -3)), path, info));
        }
      }
    } else if (user !== null) {
      docs.push(memoryDocInfo("user", actorQq, userPath, user));
    }
    result.push({
      scope: entry.name,
      chatKey: binding?.chatKey ?? null,
      kind: shared ? "shared" : "private",
      label: scopeLabel(binding?.chatKey ?? null, entry.name),
      actorQq,
      docs,
    });
  }
  return result.sort((left, right) => left.scope.localeCompare(right.scope));
}

function memoryDocInfo(kind: MemoryDocKind, actorQq: number | null, path: string, info: { size: number; mtimeMs: number }) {
  return {
    kind,
    actorQq,
    name: basename(path),
    exists: true,
    size: info.size,
    updatedAt: info.mtimeMs,
  };
}

async function memoryTarget(deps: RoleplayAdminDeps, context: PluginAdminRequestContext) {
  const personaId = context.query.get("persona") ?? "";
  const scope = context.query.get("scope") ?? "";
  const kind = context.query.get("kind") === "scene" ? "scene" : "user";
  const actorQq = Number(context.query.get("actorQq") ?? parseActorFromScope(scope) ?? 0);
  if (!MEMORY_SCOPE.test(scope)) throw new AdminHttpError(400, "invalid_scope", "scope 不合法。");
  if (!Number.isSafeInteger(actorQq) || actorQq < 0) {
    throw new AdminHttpError(400, "invalid_actor", "actorQq 不合法。");
  }
  const persona = await requirePersona(deps, personaId);
  return { persona, ref: { scope }, kind, actorQq } as const;
}

async function readMemoryDoc(
  deps: RoleplayAdminDeps,
  personaId: string,
  scope: string,
  kind: MemoryDocKind,
  actorQq: number,
) {
  const ref = { namespace: personaId, scope, actorQq };
  const bundle = await deps.documents.load(ref);
  const doc = kind === "scene" ? bundle.scene : bundle.user;
  if (doc === null) {
    throw new AdminHttpError(400, "invalid_scope", "私有 scope 没有 scene 文档。");
  }
  return memoryDoc(doc, kind);
}

async function writeMemoryDoc(
  deps: RoleplayAdminDeps,
  input: {
    personaId: string;
    scope: string;
    actorQq: number;
    kind: MemoryDocKind;
    content: string;
    allowManual: boolean;
  },
) {
  if (!MEMORY_SCOPE.test(input.scope)) throw new AdminHttpError(400, "invalid_scope", "scope 不合法。");
  const ref = {
    namespace: input.personaId,
    scope: input.scope,
    actorQq: input.actorQq,
  };
  const bundle = await deps.documents.load(ref);
  const current = input.kind === "scene" ? bundle.scene : bundle.user;
  if (input.kind === "scene" && current === null) {
    throw new AdminHttpError(400, "invalid_scope", "该 scope 不是群聊 scope。");
  }
  const parsed = parseDocument(input.content, input.kind);
  const allowed: readonly string[] = input.kind === "user" ? USER_SECTIONS : SCENE_SECTIONS;
  for (const section of parsed.sections.keys()) {
    if (!allowed.includes(section)) {
      throw new AdminHttpError(400, "invalid_section", `不允许的 section：${section}`);
    }
  }
  const beforeManual = current === null ? [] : parseDocument(current.content, input.kind).sections.get(MANUAL_SECTION) ?? [];
  const afterManual = parsed.sections.get(MANUAL_SECTION) ?? [];
  if (!input.allowManual && beforeManual.join("\n") !== afterManual.join("\n")) {
    throw new AdminHttpError(
      409,
      "manual_section_locked",
      "手动记忆 section 只能通过 !remember 或显式允许手动编辑来修改。",
    );
  }
  const saved =
    input.kind === "scene"
      ? await deps.documents.writeScene(ref, input.content)
      : await deps.documents.writeUser(ref, input.content);
  if (saved === null) throw new AdminHttpError(400, "invalid_scope", "保存记忆失败。");
  return memoryDoc(saved, input.kind);
}

function memoryDoc(doc: MemoryDoc, kind: MemoryDocKind) {
  const parsed = parseDocument(doc.content, kind);
  return {
    ...doc,
    kind,
    manualSection: MANUAL_SECTION,
    sections: [...parsed.sections.keys()],
  };
}

async function memoryHistory(
  deps: RoleplayAdminDeps,
  personaId: string,
  scope: string,
  kind: MemoryDocKind,
  actorQq: number,
) {
  const entries = await deps.documents.history(
    { namespace: personaId, scope, actorQq },
    kind,
  );
  return entries.map((entry) => ({
    name: basename(entry.path),
    path: entry.path,
    createdAt: entry.createdAt,
  }));
}

async function readMemoryHistory(deps: RoleplayAdminDeps, path: string): Promise<string> {
  const root = deps.memoryRoot;
  const resolved = await import("node:fs/promises").then(({ realpath }) =>
    realpath(path).catch(() => path),
  );
  const rel = relative(root, resolved);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.length === 0) {
    throw new AdminHttpError(400, "invalid_history", "历史文件路径不合法。");
  }
  if (!rel.endsWith(".md") || !rel.includes(`${sep}history${sep}`)) {
    throw new AdminHttpError(400, "invalid_history", "历史文件路径不合法。");
  }
  return readFile(resolved, "utf8");
}

function parseActorFromScope(scope: string): number | null {
  const match = /^private_(\d{5,12})$/.exec(scope);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function scopeLabel(chatKey: string | null, scope: string): string {
  if (chatKey?.startsWith("private:")) return `私聊 ${chatKey.slice("private:".length)}`;
  if (chatKey?.startsWith("group:")) {
    const groupId = chatKey.split(":")[1];
    return `群 ${groupId ?? ""}`;
  }
  return scope;
}

function chatFromKey(chatKey: string): PluginChat | null {
  const privateMatch = /^private:(\d{5,12})$/.exec(chatKey);
  if (privateMatch?.[1] !== undefined) {
    const userId = Number(privateMatch[1]);
    return { type: "private", userId, chatKey };
  }
  const groupMatch = /^group:(\d+)(?::(\d+))?$/.exec(chatKey);
  if (groupMatch?.[1] !== undefined) {
    return {
      type: "group",
      userId: Number(groupMatch[2] ?? 0),
      groupId: Number(groupMatch[1]),
      chatKey,
    };
  }
  return null;
}

function param(context: PluginAdminRequestContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) {
    throw new AdminHttpError(400, "missing_param", `缺少路径参数：${name}`);
  }
  return value;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = (await request.json()) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AdminHttpError(400, "invalid_json", "请求体必须是 JSON 对象。");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(400, "invalid_json", "请求体必须是 JSON 对象。");
  }
}

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new AdminHttpError(400, "invalid_form", "请求体必须是 multipart/form-data。");
  }
}

async function withAdminErrors(task: () => Promise<unknown> | unknown): Promise<PluginAdminResult> {
  try {
    return (await task()) as PluginAdminResult;
  } catch (error) {
    if (error instanceof AdminHttpError) {
      return new Response(
        JSON.stringify({ error: error.code, message: error.message }),
        {
          status: error.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function avatarExists(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.some(
    (entry) => entry.isFile() && /^avatar\.(png|jpe?g|gif|webp)$/i.test(entry.name),
  );
}

function mimeForExtension(ext: string): string {
  if (ext.toLowerCase() === ".png") return "image/png";
  if (ext.toLowerCase() === ".gif") return "image/gif";
  if (ext.toLowerCase() === ".webp") return "image/webp";
  return "image/jpeg";
}

function safeFileName(value: string): string {
  return basename(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}
