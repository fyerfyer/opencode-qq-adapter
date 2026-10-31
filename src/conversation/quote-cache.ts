import type { ChatRef } from "../domain/chat.js";
import type { IncomingMessage, QuotedMessage } from "../domain/message.js";

export const QUOTE_CACHE_MAX_ENTRIES = 500;
export const QUOTE_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedQuote {
  quote: QuotedMessage;
  cachedAt: number;
}

export interface QuoteCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface OutboundQuoteInput {
  messageId: string;
  text: string;
  senderName?: string;
  userId?: number | null;
}

/**
 * Small in-memory cache of recently received messages.
 *
 * It exists to answer quote lookups without calling NapCat for every reply,
 * and to preserve quoted text when NapCat's own history cache has rotated.
 */
export class QuoteCache {
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CachedQuote>();
  readonly #outbound = new Set<string>();

  constructor(options: QuoteCacheOptions = {}) {
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? QUOTE_CACHE_MAX_ENTRIES));
    this.#ttlMs = Math.max(0, options.ttlMs ?? QUOTE_CACHE_TTL_MS);
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  remember(scope: string, message: IncomingMessage): void {
    const quote = quotedFromMessage(message);
    this.#outbound.delete(quoteCacheKey(scope, quote.id));
    this.rememberQuote(scope, quote);
  }

  rememberQuote(scope: string, quote: QuotedMessage): void {
    const now = this.#now();
    this.prune(now);
    const key = quoteCacheKey(scope, quote.id);
    // Re-insert so insertion order (FIFO) evicts the oldest entries first.
    this.#entries.delete(key);
    this.#entries.set(key, { quote: cloneQuote(quote), cachedAt: now });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
      this.#outbound.delete(oldest);
    }
  }

  /**
   * Remember a message sent by the bridge itself.
   *
   * OneBot's `get_msg` reports the sender of a private message, so a bot reply
   * cannot be proven to belong to a particular private chat after the fact.
   * Outbound caching lets the common "reply to the bot" case work without
   * allowing a message from another private chat to be quoted.
   */
  rememberOutbound(scope: string, input: OutboundQuoteInput): void {
    const quote: QuotedMessage = {
      id: input.messageId,
      userId: input.userId ?? null,
      senderName: input.senderName ?? "Bot",
      receivedAt: this.#now(),
      text: input.text,
      images: [],
      unsupported: [],
      available: true,
    };
    this.rememberQuote(scope, quote);
    this.#outbound.add(quoteCacheKey(scope, quote.id));
  }

  get(scope: string, messageId: string): QuotedMessage | null {
    const key = quoteCacheKey(scope, messageId);
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    const now = this.#now();
    if (now - entry.cachedAt > this.#ttlMs) {
      this.#entries.delete(key);
      this.#outbound.delete(key);
      return null;
    }
    return cloneQuote(entry.quote);
  }

  /** Whether the cached message was sent by the bridge itself. */
  isOutbound(scope: string, messageId: string): boolean {
    const key = quoteCacheKey(scope, messageId);
    if (this.get(scope, messageId) === null) {
      this.#outbound.delete(key);
      return false;
    }
    return this.#outbound.has(key);
  }

  prune(now = this.#now()): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (now - entry.cachedAt <= this.#ttlMs) continue;
      this.#entries.delete(key);
      this.#outbound.delete(key);
      removed += 1;
    }
    return removed;
  }
}

/**
 * Group quotes are visible to every member of that group, so the cache must
 * not use the per-user Conversation chatKey. Private chats stay per-user.
 */
export function quoteCacheScope(chat: ChatRef): string {
  if (chat.type === "group" && chat.groupId !== undefined) {
    return `group:${chat.groupId}`;
  }
  return `private:${chat.userId}`;
}

function quoteCacheKey(scope: string, messageId: string): string {
  return `${scope}:${messageId}`;
}

function quotedFromMessage(message: IncomingMessage): QuotedMessage {
  return {
    id: message.id,
    userId: message.userId,
    senderName: message.senderName,
    receivedAt: message.receivedAt,
    text: message.text,
    images: message.images.map((image) => ({ ...image })),
    unsupported: [...(message.unsupported ?? [])],
    available: true,
  };
}

function cloneQuote(quote: QuotedMessage): QuotedMessage {
  return {
    ...quote,
    images: quote.images.map((image) => ({ ...image })),
    unsupported: [...quote.unsupported],
  };
}
