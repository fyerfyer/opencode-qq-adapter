import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { SessionOwnership } from "../conversation/ownership.js";
import { chatFromKey, textSegment } from "../domain/chat.js";
import type { AuditTrail } from "../observability/audit.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { detectImageType, formatBytes } from "./image.js";

export class PluginMediaError extends Error {
  readonly status: 400 | 403 | 404 | 413 | 415;

  constructor(status: 400 | 403 | 404 | 413 | 415, message: string) {
    super(message);
    this.name = "PluginMediaError";
    this.status = status;
  }
}

export interface SendImageInput {
  sessionId: string;
  path: string;
  caption?: string;
}

export interface PluginMediaOptions {
  config: AppConfig;
  store: StorePort;
  ownership: SessionOwnership;
  workspaces: WorkspaceManager;
  sender: MessageSender;
  audit: AuditTrail;
  logger: Logger;
  now?: () => number;
}

/** Handles the OpenCode plugin callback that lets an agent push an image to QQ. */
export class PluginMediaService {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #ownership: SessionOwnership;
  readonly #workspaces: WorkspaceManager;
  readonly #sender: MessageSender;
  readonly #audit: AuditTrail;
  readonly #logger: Logger;
  readonly #now: () => number;

  constructor(options: PluginMediaOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#ownership = options.ownership;
    this.#workspaces = options.workspaces;
    this.#sender = options.sender;
    this.#audit = options.audit;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  async sendImage(input: SendImageInput): Promise<{ messageId: string }> {
    if (!this.#config.features.images) {
      throw new PluginMediaError(403, "Image sending is disabled by configuration");
    }
    if (input.sessionId.length === 0 || input.path.trim().length === 0) {
      throw new PluginMediaError(400, "sessionId and path are required");
    }

    const owner = this.#ownership.resolve(input.sessionId);
    if (owner === null) {
      throw new PluginMediaError(404, "Session is not owned by this bridge");
    }
    const { conversation } = owner;
    const actorQq = conversation.actorQq;
    if (actorQq === null) {
      throw new PluginMediaError(404, "Conversation has no QQ actor");
    }
    const chat = chatFromKey(conversation.chatKey, actorQq);
    if (chat === null) {
      throw new PluginMediaError(404, "Conversation target is invalid");
    }

    const workspace =
      (conversation.workspaceId ? this.#store.workspaces.get(conversation.workspaceId) : null) ??
      this.#store.workspaces.getByProject(conversation.projectId);
    const workspacePath = workspace?.path ?? this.#workspaces.pathFor(conversation.projectId);
    let target: string;
    try {
      target = await this.#workspaces.resolveInside(
        workspacePath,
        isAbsolute(input.path) ? input.path : resolve(workspacePath, input.path),
      );
    } catch {
      throw new PluginMediaError(403, "Path is outside the workspace or uses a symlink escape");
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(target);
    } catch {
      throw new PluginMediaError(404, "Image file does not exist");
    }
    if (!info.isFile()) throw new PluginMediaError(400, "Path is not a regular file");
    if (info.size > this.#config.security.max_outbound_image_bytes) {
      throw new PluginMediaError(
        413,
        `Image exceeds ${formatBytes(this.#config.security.max_outbound_image_bytes)} limit`,
      );
    }
    const buffer = await readFile(target);
    const type = detectImageType(buffer);
    if (type === null) {
      throw new PluginMediaError(415, "Only PNG/JPEG/GIF/WebP images can be sent");
    }

    const caption = input.caption?.trim().slice(0, 500) ?? "";
    const sent = await this.#sender.sendSegments(chat, [
      { type: "image", file: `base64://${buffer.toString("base64")}` },
      ...(caption.length > 0 ? [textSegment(caption)] : []),
    ]);

    this.#audit.record({
      ts: this.#now(),
      actorQq,
      chatKey: conversation.chatKey,
      projectId: conversation.projectId,
      workspaceId: workspace?.id ?? conversation.workspaceId,
      action: "media.image_sent",
      detail: {
        sessionId: input.sessionId,
        path: target,
        bytes: buffer.length,
        mime: type.mime,
        messageId: sent.messageId,
      },
    });
    this.#logger.info(
      { sessionId: input.sessionId, chatKey: conversation.chatKey, bytes: buffer.length },
      "Sent image to QQ via plugin",
    );
    return { messageId: sent.messageId ?? "" };
  }
}
