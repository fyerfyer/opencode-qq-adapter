import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { SessionOwnership } from "../conversation/ownership.js";
import { type ChatRef, chatFromKey, textSegment } from "../domain/chat.js";
import type { ConversationRecord } from "../domain/conversation.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { AuditTrail } from "../observability/audit.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { detectImageType, formatBytes } from "./image.js";
import { isSensitiveFile } from "./sensitive.js";

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

export interface SendFileInput {
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

interface ResolvedTarget {
  conversation: ConversationRecord;
  chat: ChatRef;
  target: string;
  info: Stats;
  workspace: WorkspaceRecord | null;
}

/** Handles the OpenCode plugin callbacks that let an agent push media to QQ. */
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
    const resolved = await this.#resolveTarget(input.sessionId, input.path);
    if (resolved.info.size > this.#config.security.max_outbound_image_bytes) {
      throw new PluginMediaError(
        413,
        `Image exceeds ${formatBytes(this.#config.security.max_outbound_image_bytes)} limit`,
      );
    }
    const buffer = await readFile(resolved.target);
    const type = detectImageType(buffer);
    if (type === null) {
      throw new PluginMediaError(415, "Only PNG/JPEG/GIF/WebP images can be sent");
    }

    const caption = input.caption?.trim().slice(0, 500) ?? "";
    const sent = await this.#sender.sendSegments(resolved.chat, [
      { type: "image", file: `base64://${buffer.toString("base64")}` },
      ...(caption.length > 0 ? [textSegment(caption)] : []),
    ]);

    this.#audit.record({
      ts: this.#now(),
      actorQq: resolved.conversation.actorQq,
      chatKey: resolved.conversation.chatKey,
      projectId: resolved.conversation.projectId,
      workspaceId: resolved.workspace?.id ?? resolved.conversation.workspaceId,
      action: "media.image_sent",
      detail: {
        sessionId: input.sessionId,
        path: resolved.target,
        bytes: buffer.length,
        mime: type.mime,
        messageId: sent.messageId,
      },
    });
    this.#logger.info(
      {
        sessionId: input.sessionId,
        chatKey: resolved.conversation.chatKey,
        bytes: buffer.length,
      },
      "Sent image to QQ via plugin",
    );
    return { messageId: sent.messageId ?? "" };
  }

  async sendFile(input: SendFileInput): Promise<{ messageId: string }> {
    if (!this.#config.features.files) {
      throw new PluginMediaError(403, "File sending is disabled by configuration");
    }
    const resolved = await this.#resolveTarget(input.sessionId, input.path);
    if (resolved.info.size > this.#config.security.max_outbound_file_bytes) {
      throw new PluginMediaError(
        413,
        `File exceeds ${formatBytes(this.#config.security.max_outbound_file_bytes)} limit`,
      );
    }
    if (isSensitiveFile(resolved.target)) {
      throw new PluginMediaError(403, "Refusing to send secrets or repository internals");
    }

    const name = basename(resolved.target);
    // NapCat may run in a different container and cannot read host paths.
    // The OneBot/NapCat resource parser accepts `base64://` for uploads, so
    // send the bytes instead of a host absolute path.
    const buffer = await readFile(resolved.target);
    await this.#sender.sendFile(resolved.chat, `base64://${buffer.toString("base64")}`, name);

    const caption = input.caption?.trim().slice(0, 500) ?? "";
    if (caption.length > 0) {
      await this.#sender.send(resolved.chat, caption).catch((error) => {
        this.#logger.debug(
          { err: error, chatKey: resolved.conversation.chatKey },
          "File caption failed",
        );
      });
    }

    this.#audit.record({
      ts: this.#now(),
      actorQq: resolved.conversation.actorQq,
      chatKey: resolved.conversation.chatKey,
      projectId: resolved.conversation.projectId,
      workspaceId: resolved.workspace?.id ?? resolved.conversation.workspaceId,
      action: "media.file_sent",
      detail: {
        sessionId: input.sessionId,
        path: resolved.target,
        bytes: resolved.info.size,
        name,
      },
    });
    this.#logger.info(
      {
        sessionId: input.sessionId,
        chatKey: resolved.conversation.chatKey,
        bytes: resolved.info.size,
      },
      "Sent file to QQ via plugin",
    );
    return { messageId: "" };
  }

  async #resolveTarget(sessionId: string, requestedPath: string): Promise<ResolvedTarget> {
    if (sessionId.length === 0 || requestedPath.trim().length === 0) {
      throw new PluginMediaError(400, "sessionId and path are required");
    }

    const owner = this.#ownership.resolve(sessionId);
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
        isAbsolute(requestedPath) ? requestedPath : resolve(workspacePath, requestedPath),
      );
    } catch {
      throw new PluginMediaError(403, "Path is outside the workspace or uses a symlink escape");
    }

    let info: Stats;
    try {
      info = await stat(target);
    } catch {
      throw new PluginMediaError(404, "File does not exist");
    }
    if (!info.isFile()) throw new PluginMediaError(400, "Path is not a regular file");
    return { conversation, chat, target, info, workspace };
  }
}
