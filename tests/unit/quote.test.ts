import { describe, expect, it } from "vitest";
import {
  formatQuote,
  formatQuotePrompt,
  formatQuotePromptWithinBudget,
  QUOTE_CONTEXT_NOTICE,
  QUOTE_TEXT_MAX_CHARS,
} from "../../src/conversation/prompt-context.js";
import { QuoteCache, quoteCacheScope } from "../../src/conversation/quote-cache.js";
import { belongsToChat, QuoteResolver } from "../../src/conversation/quote-resolver.js";
import type { QuotedMessage } from "../../src/domain/message.js";
import { toPluginMessage } from "../../src/plugins/host/convert.js";
import type { OneBotMessageInfo } from "../../src/ports/onebot.js";
import { FakeOneBot, makeIncomingMessage } from "../helpers/fakes.js";

function quoted(overrides: Partial<QuotedMessage> = {}): QuotedMessage {
  return {
    id: "500",
    userId: 20000,
    senderName: "鱼片",
    receivedAt: Date.UTC(2026, 9, 31, 12, 0, 0),
    text: "上周说想吃白饭",
    images: [],
    unsupported: [],
    available: true,
    ...overrides,
  };
}

describe("quote prompt formatting", () => {
  it("renders sender, qq, time and text", () => {
    const block = formatQuote(quoted());
    expect(block).toContain('sender="鱼片"');
    expect(block).toContain('qq="20000"');
    expect(block).toContain('time="2026-10-31T12:00:00.000Z"');
    expect(block).toContain("上周说想吃白饭");
    expect(block.startsWith("<qq_quote ")).toBe(true);
    expect(block.endsWith("</qq_quote>")).toBe(true);
  });

  it("shows image and unsupported placeholders, including image-only quotes", () => {
    const block = formatQuote(
      quoted({
        text: "",
        images: [{ file: "a.jpg" }],
        unsupported: ["record"],
      }),
    );
    expect(block).toContain("[图片]");
    expect(block).toContain("[record]");

    const empty = formatQuote(quoted({ text: "", images: [], unsupported: [] }));
    expect(empty).toContain("（无文字内容）");
  });

  it("escapes XML text and attributes, and caps quoted text at the default budget", () => {
    const escaped = formatQuote(quoted({ text: `1 < 2 & "x" 'y'` }));
    expect(escaped).toContain(`1 &lt; 2 &amp; "x" 'y'`);
    expect(escaped).not.toContain("1 < 2 &");
    expect(formatQuote(quoted({ senderName: `A "B" <C>` }))).toContain(
      'sender="A &quot;B&quot; &lt;C&gt;"',
    );

    const long = formatQuote(quoted({ text: "白".repeat(QUOTE_TEXT_MAX_CHARS + 100) }));
    expect(long).toContain("…");
    expect(long).not.toContain("白".repeat(QUOTE_TEXT_MAX_CHARS + 1));
  });

  it("renders unavailable quotes without hiding the failure", () => {
    const block = formatQuote(
      quoted({ available: false, unavailableReason: "not_found", text: "" }),
    );
    expect(block).toContain('unavailable="true"');
    expect(block).toContain('reason="not_found"');
    expect(block).toContain("引用消息不可用");
  });

  it("adds the guard sentence before the user message", () => {
    const prompt = formatQuotePrompt(quoted());
    expect(prompt).toContain("<qq_quote ");
    expect(prompt).toContain(QUOTE_CONTEXT_NOTICE);
    expect(prompt.indexOf("</qq_quote>")).toBeLessThan(prompt.indexOf(QUOTE_CONTEXT_NOTICE));
  });

  it("omits or shrinks a quote to stay within the prompt budget", () => {
    expect(formatQuotePromptWithinBudget(quoted(), 8000, 8000)).toBe("");

    const prompt = formatQuotePromptWithinBudget(quoted({ text: "白".repeat(5000) }), 7000, 8000);
    expect(prompt).toContain("<qq_quote ");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(1400);
  });
});

describe("QuoteCache", () => {
  it("evicts the oldest entries and expires stale quotes", () => {
    let now = 1_000;
    const cache = new QuoteCache({ maxEntries: 2, ttlMs: 100, now: () => now });
    cache.remember("private:20000", makeIncomingMessage({ id: "1", text: "one" }));
    cache.remember("private:20000", makeIncomingMessage({ id: "2", text: "two" }));
    cache.remember("private:20000", makeIncomingMessage({ id: "3", text: "three" }));

    expect(cache.size).toBe(2);
    expect(cache.get("private:20000", "1")).toBeNull();
    expect(cache.get("private:20000", "2")?.text).toBe("two");

    now += 101;
    expect(cache.get("private:20000", "2")).toBeNull();
  });

  it("keeps private chats isolated", () => {
    const cache = new QuoteCache();
    cache.remember("private:20000", makeIncomingMessage({ id: "1", text: "secret" }));
    expect(cache.get("private:20001", "1")).toBeNull();
  });

  it("shares group quotes across members but isolates other groups", () => {
    const cache = new QuoteCache();
    const memberA = {
      type: "group" as const,
      userId: 20000,
      groupId: 30001,
      chatKey: "group:30001:20000",
    };
    const memberB = {
      type: "group" as const,
      userId: 20001,
      groupId: 30001,
      chatKey: "group:30001:20001",
    };
    const otherGroup = {
      type: "group" as const,
      userId: 20000,
      groupId: 30002,
      chatKey: "group:30002:20000",
    };
    cache.remember(
      quoteCacheScope(memberA),
      makeIncomingMessage({
        id: "g1",
        text: "group message",
        chat: memberA,
      }),
    );
    expect(cache.get(quoteCacheScope(memberB), "g1")?.text).toBe("group message");
    expect(cache.get(quoteCacheScope(otherGroup), "g1")).toBeNull();
  });
});

describe("QuoteResolver", () => {
  it("prefers the cache and falls back to OneBot get_msg", async () => {
    const onebot = new FakeOneBot();
    const cache = new QuoteCache();
    const resolver = new QuoteResolver({ onebot, cache });

    cache.remember("private:20000", makeIncomingMessage({ id: "499", text: "cached text" }));
    expect((await resolver.resolve(makeIncomingMessage({ replyToId: "499" })))?.text).toBe(
      "cached text",
    );
    expect(onebot.getMessageCalls).toEqual([]);

    onebot.messageHistory.set("500", {
      messageId: "500",
      messageType: "private",
      userId: 20000,
      groupId: null,
      senderName: "鱼片",
      receivedAt: Date.UTC(2026, 9, 31, 12, 0, 0),
      text: "remote text",
      images: [{ file: "a.jpg" }],
      unsupported: [],
    });
    const remote = await resolver.resolve(makeIncomingMessage({ replyToId: "500" }));
    expect(remote).toMatchObject({ text: "remote text", available: true });
    expect(onebot.getMessageCalls).toEqual(["500"]);

    await resolver.resolve(makeIncomingMessage({ replyToId: "500" }));
    expect(onebot.getMessageCalls).toEqual(["500"]);
  });

  it("returns unavailable quotes for fetch failures, missing messages and other chats", async () => {
    const onebot = new FakeOneBot();
    const resolver = new QuoteResolver({ onebot, cache: new QuoteCache() });
    const message = makeIncomingMessage({ replyToId: "500" });

    expect((await resolver.resolve(message))?.unavailableReason).toBe("not_found");

    onebot.getMessageError = "timeout";
    expect((await resolver.resolve(message))?.unavailableReason).toBe("fetch_failed");

    onebot.getMessageError = null;
    onebot.messageHistory.set("500", {
      messageId: "500",
      messageType: "private",
      userId: 20001,
      groupId: null,
      senderName: "Other",
      receivedAt: null,
      text: "from another private chat",
      images: [],
      unsupported: [],
    });
    expect((await resolver.resolve(message))?.unavailableReason).toBe("not_authorized");
  });

  it("does not resolve anything when the user did not reply", async () => {
    const onebot = new FakeOneBot();
    const resolver = new QuoteResolver({ onebot, cache: new QuoteCache() });
    expect(await resolver.resolve(makeIncomingMessage())).toBeUndefined();
    expect(onebot.getMessageCalls).toEqual([]);
  });

  it("accepts a cached outbound bot message without calling get_msg", async () => {
    const onebot = new FakeOneBot();
    const cache = new QuoteCache();
    const resolver = new QuoteResolver({ onebot, cache });
    cache.rememberOutbound("private:20000", {
      messageId: "600",
      text: "bot reply",
      userId: 10000,
      senderName: "FakeBot",
    });

    const quote = await resolver.resolve(makeIncomingMessage({ replyToId: "600" }));
    expect(quote?.text).toBe("bot reply");
    expect(onebot.getMessageCalls).toEqual([]);
  });

  it("rejects an uncached bot message fetched from get_msg", () => {
    const chat = {
      type: "private" as const,
      userId: 20000,
      chatKey: "private:20000",
    };
    const info: OneBotMessageInfo = {
      messageId: "601",
      messageType: "private",
      userId: 10000,
      groupId: null,
      senderName: "FakeBot",
      receivedAt: null,
      text: "another chat's bot reply",
      images: [],
      unsupported: [],
    };
    expect(belongsToChat(chat, info)).toBe(false);
  });
});

describe("plugin quote conversion", () => {
  it("exposes the quote on PluginMessage without sharing mutable arrays", () => {
    const quote = quoted({ images: [{ file: "a.jpg" }], unsupported: ["record"] });
    const message = makeIncomingMessage({ replyToId: "500", quote });
    const plugin = toPluginMessage(message);

    expect(plugin.quote).toMatchObject({
      id: "500",
      text: "上周说想吃白饭",
      available: true,
      unsupported: ["record"],
    });
    plugin.quote?.images.push({ file: "b.jpg" });
    expect(quote.images).toHaveLength(1);
  });
});
