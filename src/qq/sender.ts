import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import { atSegment, type ChatRef, type OutgoingSegment, textSegment } from "../domain/chat.js";
import type { OneBotPort, OneBotSendResult } from "../ports/onebot.js";
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

  async reply(chat: ChatRef, messageId: string, text: string): Promise<OneBotSendResult> {
    const chunks = this.#prepare(text);
    if (chunks.length === 0) return { messageId: "" };
    const first = await this.#sendChunk(chat, chunks[0] ?? "", messageId, true);
    for (const chunk of chunks.slice(1)) {
      await this.#sendChunk(chat, chunk, messageId, false);
    }
    return first;
  }

  async send(chat: ChatRef, text: string): Promise<OneBotSendResult> {
    const chunks = this.#prepare(text);
    let first: OneBotSendResult = { messageId: "" };
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.#sendChunk(chat, chunk, null, index === 0);
      if (index === 0) first = result;
    }
    return first;
  }

  async sendSegments(chat: ChatRef, segments: OutgoingSegment[]): Promise<OneBotSendResult> {
    if (chat.type === "group" && chat.groupId !== undefined) {
      return this.#onebot.sendGroup(chat.groupId, segments);
    }
    return this.#onebot.sendPrivate(chat.userId, segments);
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
  ): Promise<OneBotSendResult> {
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
        return await this.#onebot.reply(chat, messageId, segments);
      }
      if (chat.type === "group" && chat.groupId !== undefined) {
        return await this.#onebot.sendGroup(chat.groupId, segments);
      }
      return await this.#onebot.sendPrivate(chat.userId, segments);
    } catch (error) {
      this.#logger.error(
        { err: error, chatKey: chat.chatKey, length: chunk.length },
        "Failed to send QQ message",
      );
      throw error;
    }
  }
}
