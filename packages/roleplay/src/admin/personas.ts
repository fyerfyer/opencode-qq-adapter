import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  deletePersona,
  importCard,
  renderWorldbookMarkdown,
  updatePersonaNotes,
} from "../persona.js";
import {
  formatWorldbookTrace,
  isWorldbookEntry,
  selectWorldbookDetailed,
  type WorldbookEntry,
} from "../worldbook.js";
import {
  AdminHttpError,
  type AdminRoute,
  type RoleplayAdminDeps,
  MAX_CARD_BYTES,
  listPersonaSummaries,
  mimeForExtension,
  param,
  personaDetail,
  readForm,
  readJson,
  requirePersona,
  safeFileName,
} from "./shared.js";

export function registerPersonaRoutes(route: AdminRoute, deps: RoleplayAdminDeps): void {
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
      await writeFile(temporary, bytes, { mode: 0o600 });
      const requestedId = form.get("id");
      const id =
        typeof requestedId === "string" && requestedId.trim().length > 0
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
    if (avatar === undefined) {
      throw new AdminHttpError(404, "avatar_not_found", "角色没有头像。");
    }
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
    return { entries: await deps.worldbookFor(persona) };
  });
  route("PUT", "/personas/:id/worldbook", async (context) => {
    const persona = await requirePersona(deps, param(context, "id"));
    const body = await readJson(context.request);
    if (!Array.isArray(body.entries) || !body.entries.every(isWorldbookEntry)) {
      throw new AdminHttpError(400, "invalid_worldbook", "世界书条目格式不正确。");
    }
    const entries = body.entries as WorldbookEntry[];
    const dir = persona.dir;
    await Promise.all([
      writeFile(join(dir, "worldbook.json"), `${JSON.stringify(entries, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(join(dir, "worldbook.md"), renderWorldbookMarkdown(entries), {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);
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
      await deps.worldbookFor(persona),
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
}
