import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AppConfig } from "../config/schema.js";
import type { ChatRef } from "../domain/chat.js";
import { detectImageType, formatBytes } from "../media/image.js";
import { isSensitiveFile } from "../media/sensitive.js";
import type { MessageSender } from "../qq/sender.js";
import type {
  PluginChat,
  PluginFileInput,
  PluginImageInput,
  PluginLogger,
  PluginMessage,
  PluginMessages,
  PluginSendResult,
} from "./sdk.js";

export class PluginMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginMessageError";
  }
}

/**
 * Plugin-facing outbound API. Text goes through the normal sender (Markdown
 * stripping and splitting). Media is restricted to the plugin data directory so
 * a plugin cannot exfiltrate arbitrary host files by accident.
 */
export class PluginMessageService {
  readonly #config: AppConfig;
  readonly #sender: MessageSender;
  readonly #logger: PluginLogger;
  readonly #dataDir: string;

  constructor(options: {
    config: AppConfig;
    sender: MessageSender;
    logger: PluginLogger;
    dataDir: string;
  }) {
    this.#config = options.config;
    this.#sender = options.sender;
    this.#logger = options.logger;
    this.#dataDir = options.dataDir;
  }

  createApi(): PluginMessages {
    return {
      reply: (message, text) => this.reply(message, text),
      send: (chat, text) => this.send(chat, text),
      sendImage: (chat, input) => this.sendImage(chat, input),
      sendFile: (chat, input) => this.sendFile(chat, input),
    };
  }

  async reply(message: PluginMessage, text: string): Promise<PluginSendResult> {
    const result = await this.#sender.reply(chatRef(message.chat), message.id, text);
    return { messageId: result.messageId ?? "" };
  }

  async send(chat: PluginChat, text: string): Promise<PluginSendResult> {
    const result = await this.#sender.send(chatRef(chat), text, { mention: false });
    return { messageId: result.messageId ?? "" };
  }

  async sendImage(chat: PluginChat, input: PluginImageInput): Promise<PluginSendResult> {
    if (!this.#config.features.images) {
      throw new PluginMessageError("图片发送已被 features.images 关闭");
    }
    const target = await this.#resolve(input.path);
    const info = await stat(target);
    if (!info.isFile()) throw new PluginMessageError("路径不是普通文件");
    if (info.size > this.#config.security.max_outbound_image_bytes) {
      throw new PluginMessageError(
        `图片超过 ${formatBytes(this.#config.security.max_outbound_image_bytes)} 限制`,
      );
    }
    const buffer = await readFile(target);
    const type = detectImageType(buffer);
    if (type === null) {
      throw new PluginMessageError("只支持 PNG / JPEG / GIF / WebP 图片");
    }
    const caption = input.caption?.trim().slice(0, 500) ?? "";
    const result = await this.#sender.sendSegments(chatRef(chat), [
      { type: "image", file: `base64://${buffer.toString("base64")}` },
      ...(caption.length > 0 ? [{ type: "text" as const, text: caption }] : []),
    ]);
    this.#logger.debug(
      { pluginDataDir: this.#dataDir, path: target, bytes: buffer.length, mime: type.mime },
      "Plugin sent an image",
    );
    return { messageId: result.messageId ?? "" };
  }

  async sendFile(chat: PluginChat, input: PluginFileInput): Promise<PluginSendResult> {
    if (!this.#config.features.files) {
      throw new PluginMessageError("文件发送已被 features.files 关闭");
    }
    const target = await this.#resolve(input.path);
    const info = await stat(target);
    if (!info.isFile()) throw new PluginMessageError("路径不是普通文件");
    if (info.size > this.#config.security.max_outbound_file_bytes) {
      throw new PluginMessageError(
        `文件超过 ${formatBytes(this.#config.security.max_outbound_file_bytes)} 限制`,
      );
    }
    if (isSensitiveFile(target)) {
      throw new PluginMessageError("拒绝发送 .env、密钥或仓库内部文件");
    }
    const buffer = await readFile(target);
    const name = input.name?.trim() || basename(target);
    await this.#sender.sendFile(chatRef(chat), `base64://${buffer.toString("base64")}`, name);
    const caption = input.caption?.trim().slice(0, 500) ?? "";
    if (caption.length > 0) {
      await this.#sender.send(chatRef(chat), caption, { mention: false }).catch((error) => {
        this.#logger.debug({ err: error }, "Plugin file caption failed");
      });
    }
    this.#logger.debug(
      { pluginDataDir: this.#dataDir, path: target, bytes: info.size, name },
      "Plugin sent a file",
    );
    return { messageId: "" };
  }

  async #resolve(candidate: string): Promise<string> {
    if (candidate.trim().length === 0) throw new PluginMessageError("path 不能为空");
    const root = await realpath(this.#dataDir);
    const requested = isAbsolute(candidate) ? resolve(candidate) : join(root, candidate);
    let target: string;
    try {
      target = await realpath(requested);
    } catch {
      throw new PluginMessageError("文件不存在");
    }
    const rel = relative(root, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new PluginMessageError("文件必须位于插件数据目录内，或使用了 symlink 逃逸");
    }
    return target;
  }
}

function chatRef(chat: PluginChat): ChatRef {
  return {
    type: chat.type,
    userId: chat.userId,
    ...(chat.groupId !== undefined ? { groupId: chat.groupId } : {}),
    chatKey: chat.chatKey,
  };
}
