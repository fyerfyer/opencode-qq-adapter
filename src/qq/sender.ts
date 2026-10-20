import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { atSegment, type ChatRef, type OutgoingSegment, textSegment } from "../domain/chat.js";
import type { OneBotPort } from "../ports/onebot.js";
import { markdownToPlain, splitMessage } from "./text.js";

export class MessageSender {
  readonly #onebot: OneBotPort;
  readonly #config: AppConfig["qq"];
  readonly #logger: Logger;

  constructor(onebot: OneBotPort, config: AppConfig["qq"], logger: Logger) {
    this.#onebot = onebot;
    this.#config = config;
    this.#logger = logger;
  }

  async reply(chat: ChatRef, messageId: string, text: string): Promise<void> {
    const chunks = this.#prepare(text);
    if (chunks.length === 0) return;
    await this.#sendChunk(chat, chunks[0] ?? "", messageId, true);
    for (const chunk of chunks.slice(1)) {
      await this.#sendChunk(chat, chunk, messageId, false);
    }
  }

  async send(chat: ChatRef, text: string): Promise<void> {
    const chunks = this.#prepare(text);
    for (const [index, chunk] of chunks.entries()) {
      await this.#sendChunk(chat, chunk, null, index === 0);
    }
  }

  async sendSegments(chat: ChatRef, segments: OutgoingSegment[]): Promise<void> {
    if (chat.type === "group" && chat.groupId !== undefined) {
      await this.#onebot.sendGroup(chat.groupId, segments);
    } else {
      await this.#onebot.sendPrivate(chat.userId, segments);
    }
  }

  #prepare(text: string): string[] {
    const formatted = this.#config.strip_markdown ? markdownToPlain(text) : text.trim();
    if (formatted.length === 0) return [];
    return splitMessage(formatted, this.#config.max_message_chars);
  }

  async #sendChunk(
    chat: ChatRef,
    chunk: string,
    messageId: string | null,
    allowMention: boolean,
  ): Promise<void> {
    const segments = [];
    if (
      chat.type === "group" &&
      this.#config.mention_sender_in_group &&
      allowMention &&
      chat.userId > 0
    ) {
      segments.push(atSegment(chat.userId));
      segments.push(textSegment(" "));
    }
    segments.push(textSegment(chunk));

    try {
      if (messageId !== null && this.#config.reply_to_message) {
        await this.#onebot.reply(chat, messageId, segments);
      } else if (chat.type === "group" && chat.groupId !== undefined) {
        await this.#onebot.sendGroup(chat.groupId, segments);
      } else {
        await this.#onebot.sendPrivate(chat.userId, segments);
      }
    } catch (error) {
      this.#logger.error(
        { err: error, chatKey: chat.chatKey, length: chunk.length },
        "Failed to send QQ message",
      );
      throw error;
    }
  }
}
