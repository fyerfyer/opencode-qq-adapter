import type { Logger } from "pino";
import type { ChatRef } from "../domain/chat.js";
import type { IncomingMessage, QuotedMessage, QuotedUnavailableReason } from "../domain/message.js";
import type { OneBotMessageInfo, OneBotPort } from "../ports/onebot.js";
import { type QuoteCache, quoteCacheScope } from "./quote-cache.js";

export interface QuoteResolverOptions {
  onebot: Pick<OneBotPort, "getMessage">;
  cache: QuoteCache;
  logger?: Logger;
}

/**
 * Resolve `replyToId` to a one-level quoted message.
 *
 * Cache hits are preferred; misses fall back to OneBot `get_msg`. Every
 * failure returns an `available: false` quote instead of rejecting the user's
 * prompt.
 */
export class QuoteResolver {
  readonly #onebot: Pick<OneBotPort, "getMessage">;
  readonly #cache: QuoteCache;
  readonly #logger: Logger | undefined;

  constructor(options: QuoteResolverOptions) {
    this.#onebot = options.onebot;
    this.#cache = options.cache;
    this.#logger = options.logger;
  }

  /** Cheap check used by the group mention gate; never calls OneBot. */
  isKnownOutbound(message: IncomingMessage): boolean {
    if (message.replyToId === undefined) return false;
    return this.#cache.isOutbound(quoteCacheScope(message.chat), message.replyToId);
  }

  async resolve(message: IncomingMessage): Promise<QuotedMessage | undefined> {
    const replyToId = message.replyToId;
    if (replyToId === undefined || replyToId.length === 0) return undefined;

    const scope = quoteCacheScope(message.chat);
    const cached = this.#cache.get(scope, replyToId);
    if (cached !== null) return cached;

    let info: OneBotMessageInfo | null;
    try {
      info = await this.#onebot.getMessage(replyToId);
    } catch (error) {
      this.#logger?.debug(
        { err: error, messageId: replyToId },
        "Could not fetch quoted message from OneBot",
      );
      return unavailableQuote(replyToId, "fetch_failed");
    }

    if (info === null) {
      this.#logger?.debug({ messageId: replyToId }, "Quoted message was not found");
      return unavailableQuote(replyToId, "not_found");
    }
    if (!belongsToChat(message.chat, info)) {
      this.#logger?.warn(
        { messageId: replyToId, chatKey: message.chat.chatKey },
        "Rejected quoted message from another chat",
      );
      return unavailableQuote(replyToId, "not_authorized");
    }

    const quote = quoteFromInfo(info, replyToId);
    this.#cache.rememberQuote(scope, quote);
    return quote;
  }
}

function quoteFromInfo(info: OneBotMessageInfo, id: string): QuotedMessage {
  return {
    // The request id is authoritative. get_msg may serialize a numeric id
    // differently, and using it would split cache entries for the same quote.
    id,
    userId: info.userId,
    senderName: info.senderName,
    receivedAt: info.receivedAt,
    text: info.text,
    images: info.images.map((image) => ({ ...image })),
    unsupported: [...info.unsupported],
    available: true,
  };
}

export function belongsToChat(chat: ChatRef, info: OneBotMessageInfo): boolean {
  if (chat.type === "group") {
    return info.messageType === "group" && info.groupId === chat.groupId;
  }
  // A private chat has only the user and the bot. The bot's own replies are
  // resolved from the outbound QuoteCache before `get_msg` is consulted, so a
  // fetched message is only trusted when its sender is this chat's user.
  return info.messageType === "private" && info.userId === chat.userId;
}

function unavailableQuote(messageId: string, reason: QuotedUnavailableReason): QuotedMessage {
  return {
    id: messageId,
    userId: null,
    senderName: "",
    receivedAt: null,
    text: "",
    images: [],
    unsupported: [],
    available: false,
    unavailableReason: reason,
  };
}
