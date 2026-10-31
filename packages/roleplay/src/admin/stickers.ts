import { chooseSticker } from "../stickers.js";
import {
  deleteStickerFile,
  readSticker,
  readStickerThumbnail,
  renameStickerEmotion,
  saveStickerFiles,
} from "../sticker-files.js";
import {
  AdminHttpError,
  type AdminRoute,
  type RoleplayAdminDeps,
  chatFromKey,
  param,
  readForm,
  readJson,
  requirePersona,
  stickerInfo,
  stickerList,
  stickerOverview,
  stickerOwner,
} from "./shared.js";

export function registerStickerRoutes(route: AdminRoute, deps: RoleplayAdminDeps): void {
  route("GET", "/personas/:id/stickers", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    return stickerList(deps, owner.id);
  });
  route("GET", "/stickers", async () => stickerOverview(deps));
  route("POST", "/personas/:id/stickers/:emotion", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    const form = await readForm(context.request);
    const files = form.getAll("files");
    if (files.length === 0) {
      throw new AdminHttpError(400, "missing_files", "请上传至少一张图片。");
    }
    const uploads = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      if (file.size > 20 * 1024 * 1024) {
        throw new AdminHttpError(413, "sticker_too_large", `${file.name} 超过 20 MiB。`);
      }
      uploads.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    }
    if (uploads.length === 0) {
      throw new AdminHttpError(400, "missing_files", "请上传图片文件。");
    }
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
      files: result.uploaded.map((file) =>
        stickerInfo(deps, owner.id, param(context, "emotion"), file),
      ),
    };
  });
  route("PATCH", "/personas/:id/stickers/:emotion", async (context) => {
    const owner = await stickerOwner(deps, param(context, "id"));
    const body = await readJson(context.request);
    const emotion = typeof body.emotion === "string" ? body.emotion.trim().toLowerCase() : "";
    if (emotion.length === 0) {
      throw new AdminHttpError(400, "invalid_emotion", "新情绪名不能为空。");
    }
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
    const catalog = await deps.stickerCatalogFor(persona.id);
    const path = chooseSticker(
      catalog,
      emotion,
      `admin-test:${persona.id}:${emotion}`,
      new Map(),
    );
    if (path === null) {
      throw new AdminHttpError(404, "sticker_not_found", "没有该情绪的表情。");
    }
    const chatKey = typeof body.chatKey === "string" ? body.chatKey : null;
    const binding =
      chatKey === null
        ? (deps.bindings.list().find((item) => item.namespace === persona.id) ?? null)
        : (deps.bindings.list().find((item) => item.chatKey === chatKey) ?? null);
    if (binding === null) {
      throw new AdminHttpError(409, "no_binding", "该角色还没有绑定 QQ 会话，请先在 QQ 中启用。");
    }
    const chat = chatFromKey(binding.chatKey);
    if (chat === null) throw new AdminHttpError(409, "invalid_binding", "绑定会话格式不正确。");
    const result = await deps.messages.sendImage(chat, {
      path,
      caption: `sticker:${emotion}`,
    });
    return { messageId: result.messageId, path };
  });
}
