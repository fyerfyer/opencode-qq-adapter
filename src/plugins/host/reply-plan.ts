import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { ResolvedReplyPlan, ResolvedReplySegment } from "../../conversation/reply-plan.js";
import type { ActiveRun } from "../../conversation/types.js";
import type { AuditTrail } from "../../observability/audit.js";
import { readPluginImage } from "../messages.js";
import { isRecord, normalizeReplyText } from "./convert.js";
import type { PluginInstance } from "./types.js";

export interface NormalizeReplyPlanInput {
  instance: PluginInstance;
  active: ActiveRun;
  value: unknown;
  config: AppConfig;
  logger: Logger;
  audit: AuditTrail;
  now: () => number;
}

export async function normalizeReplyPlan(
  input: NormalizeReplyPlanInput,
): Promise<ResolvedReplyPlan | null> {
  const { instance, active, value, config, logger, audit, now } = input;
  if (!isRecord(value)) return null;
  const replyText = normalizeReplyText(value.replyText);
  if (value.suppress === true) {
    return {
      segments: [],
      suppress: true,
      ...(replyText !== undefined ? { replyText } : {}),
    };
  }
  if (!Array.isArray(value.segments)) return null;
  if (value.segments.length === 0 || value.segments.length > 8) return null;

  const resolved: ResolvedReplySegment[] = [];
  const maxImages = Math.max(0, Math.floor(config.qq.max_reply_images));
  let images = 0;
  let chars = 0;
  for (const item of value.segments) {
    if (!isRecord(item)) continue;
    const delayMs =
      typeof item.delayMs === "number" && Number.isFinite(item.delayMs)
        ? Math.max(0, Math.min(5000, Math.floor(item.delayMs)))
        : 0;
    if (typeof item.text === "string") {
      const text = item.text.trim();
      if (text.length === 0) continue;
      chars += text.length;
      if (chars > 8000) return null;
      resolved.push({ kind: "text", text, ...(delayMs > 0 ? { delayMs } : {}) });
      continue;
    }
    if (!isRecord(item.image)) continue;
    const path = typeof item.image.path === "string" ? item.image.path.trim() : "";
    if (path.length === 0) continue;
    if (images >= maxImages) {
      logger.warn(
        { pluginId: instance.id, runId: active.record.id, path },
        "Plugin reply exceeds the image limit; skipping image segment",
      );
      continue;
    }
    try {
      const image = await readPluginImage({
        dataDir: instance.dataDir,
        path,
        maxBytes: config.security.max_outbound_image_bytes,
        imagesEnabled: config.features.images,
      });
      images += 1;
      const caption =
        typeof item.image.caption === "string" ? item.image.caption.trim().slice(0, 500) : "";
      resolved.push({
        kind: "image",
        dataUri: image.dataUri,
        bytes: image.bytes,
        mime: image.mime,
        pluginId: instance.id,
        sourcePath: image.path,
        ...(caption.length > 0 ? { caption } : {}),
        ...(delayMs > 0 ? { delayMs } : {}),
      });
      audit.record({
        ts: now(),
        actorQq: active.message.userId,
        chatKey: active.message.chat.chatKey,
        projectId: active.record.projectId,
        workspaceId: active.workspaceId,
        action: "plugin.reply_image",
        detail: {
          pluginId: instance.id,
          runId: active.record.id,
          path: image.path,
          bytes: image.bytes,
          mime: image.mime,
        },
      });
    } catch (error) {
      logger.warn(
        { err: error, pluginId: instance.id, runId: active.record.id, path },
        "Plugin reply image rejected; skipping image segment",
      );
    }
  }

  if (resolved.length === 0) {
    logger.warn(
      { pluginId: instance.id, runId: active.record.id },
      "Plugin reply plan had no valid segments; suppressing the reply",
    );
    return {
      segments: [],
      suppress: true,
      ...(replyText !== undefined ? { replyText } : {}),
    };
  }
  return {
    segments: resolved,
    ...(replyText !== undefined ? { replyText } : {}),
  };
}
