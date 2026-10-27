import { describe, expect, it } from "vitest";
import type { OneBotMessageEvent, OneBotSegment } from "../../src/onebot/protocol.js";
import {
  normalizeSegments,
  parseCQString,
  summarizeSegments,
  toIncomingMessage,
} from "../../src/onebot/segments.js";

describe("OneBot segments", () => {
  it("parses CQ codes including escaped characters", () => {
    const segments = parseCQString(
      "hello&#91;x&#93; [CQ:at,qq=10001] [CQ:image,file=https://example.com/a.png,summary=hi] [CQ:reply,id=42]",
    );
    expect(segments).toEqual([
      { type: "text", data: { text: "hello[x] " } },
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " " } },
      { type: "image", data: { file: "https://example.com/a.png", summary: "hi" } },
      { type: "text", data: { text: " " } },
      { type: "reply", data: { id: "42" } },
    ]);
  });

  it("accepts array and string message formats", () => {
    const base = event();
    expect(normalizeSegments({ ...base, message: "hi" })).toEqual([
      { type: "text", data: { text: "hi" } },
    ]);
    expect(
      normalizeSegments({ ...base, message: [{ type: "text", data: { text: "hi" } }] }),
    ).toHaveLength(1);
  });

  it("summarizes text, images, reply and at segments", () => {
    const summary = summarizeSegments([
      { type: "reply", data: { id: 99 } },
      { type: "at", data: { qq: "10000" } },
      { type: "text", data: { text: " hello " } },
      { type: "image", data: { file: "abc.image", url: "https://example.com/x.jpg" } },
      { type: "record", data: {} },
    ]);
    expect(summary.text).toBe("hello");
    expect(summary.replyToId).toBe("99");
    expect(summary.mentioned.has("10000")).toBe(true);
    expect(summary.images).toEqual([{ file: "abc.image", url: "https://example.com/x.jpg" }]);
    expect(summary.unsupportedTypes).toContain("record");
  });

  it("builds a private incoming message with mention detection", () => {
    const message = toIncomingMessage(event(), 10000);
    expect(message.chat.chatKey).toBe("private:20000");
    expect(message.id).toBe("1234");
    expect(message.text).toBe("hello bot");
    expect(message.mentionsBot).toBe(true);
    expect(message.senderName).toBe("Tester");
  });

  it("always uses per-user chat keys for group messages", () => {
    const groupEvent: OneBotMessageEvent = {
      ...event(),
      message_type: "group",
      group_id: 30000,
      message: [{ type: "text", data: { text: "!ping" } }],
    };
    expect(toIncomingMessage(groupEvent, 10000).chat.chatKey).toBe("group:30000:20000");
  });
});

function event(): OneBotMessageEvent {
  const message: OneBotSegment[] = [
    { type: "at", data: { qq: "10000" } },
    { type: "text", data: { text: " hello bot" } },
  ];
  return {
    time: 1_700_000_000,
    self_id: 10000,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 1234,
    user_id: 20000,
    message,
    raw_message: "hello bot",
    sender: { user_id: 20000, nickname: "Tester" },
  };
}
