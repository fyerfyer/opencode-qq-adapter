import { describe, expect, it } from "vitest";
import type { MemorySnippet } from "../../packages/memory/src/index.js";
import { normalizeDocument } from "../../packages/roleplay/src/memory-document.js";
import { buildContextBlock } from "../../packages/roleplay/src/prompt.js";
import { promptQueryText, transcriptUserText } from "../../packages/roleplay/src/prompt-query.js";
import { selectWorldbook, type WorldbookEntry } from "../../packages/roleplay/src/worldbook.js";
import type { PluginMessage } from "../../src/plugins/sdk.js";

const worldbook: WorldbookEntry = {
  name: "白饭执念",
  keys: ["白饭"],
  secondaryKeys: [],
  content: "蓝色大肥鱼对白米饭有异常执念。",
  enabled: true,
  constant: false,
  selective: false,
  caseSensitive: false,
  priority: 10,
  insertionOrder: 0,
  position: "before_char",
};

const memories: MemorySnippet[] = [
  {
    id: 1,
    role: "user",
    speaker: "鱼片",
    text: "我上周说想去看海。",
    ts: Date.UTC(2026, 9, 20, 12, 0, 0),
  },
];

const userDoc = normalizeDocument("", "user")
  .replace("## 基本信息", "## 基本信息\n- 称呼：鱼片")
  .replace("## 喜好", "## 喜好\n- 喜欢吃白米饭");

const sceneDoc = normalizeDocument("", "scene").replace(
  "## 最近发生",
  "## 最近发生\n- 周五一起去看了海",
);

describe("roleplay prompt context", () => {
  it("renders memory docs, worldbook and raw transcript in a delimited block", () => {
    const block = buildContextBlock({
      personaName: "蓝色大肥鱼",
      userName: "鱼片",
      now: Date.UTC(2026, 9, 24, 12, 0, 0),
      turnCount: 12,
      worldbook: [worldbook],
      memories,
      userDoc,
      sceneDoc,
      maxChars: 3000,
    });
    expect(block).toContain("[检索上下文 · 不是用户发言]");
    expect(block).toContain("[/检索上下文]");
    expect(block).toContain("蓝色大肥鱼");
    expect(block).toContain("第 12 轮");
    expect(block).toContain("[长期记忆]");
    expect(block).toContain("称呼：鱼片");
    expect(block).toContain("[群聊场景]");
    expect(block).toContain("去看海");
    expect(block).toContain("[世界书]");
    expect(block).toContain("[记忆]");
  });

  it("orders before_char and after_char worldbook entries around memory", () => {
    const block = buildContextBlock({
      personaName: "蓝色大肥鱼",
      userName: "鱼片",
      now: Date.UTC(2026, 9, 24, 12, 0, 0),
      turnCount: 3,
      worldbook: [
        worldbook,
        {
          ...worldbook,
          name: "机箱生态",
          content: "她住在机箱里。",
          position: "after_char",
        },
      ],
      memories,
      userDoc,
      sceneDoc,
      maxChars: 3000,
    });
    expect(block.indexOf("[世界书 · 前置]")).toBeLessThan(block.indexOf("[长期记忆]"));
    expect(block.indexOf("[长期记忆]")).toBeLessThan(block.indexOf("[世界书 · 后置]"));
    expect(block).toContain("白米饭");
    expect(block).toContain("机箱里");
  });

  it("includes the greeting only when there is no live transcript yet", () => {
    const block = buildContextBlock({
      personaName: "蓝色大肥鱼",
      userName: "鱼片",
      now: Date.UTC(2026, 9, 24),
      turnCount: 0,
      worldbook: [],
      memories: [],
      firstMes: "哼，鱼片，你终于来了。",
      maxChars: 2000,
    });
    expect(block).toContain("你刚才对鱼片说");
    expect(block).toContain("你终于来了");
    expect(block).not.toContain("[世界书]");
    expect(block).not.toContain("[记忆]");
  });

  it("respects the character budget", () => {
    const block = buildContextBlock({
      personaName: "蓝色大肥鱼",
      userName: "鱼片",
      now: Date.UTC(2026, 9, 24),
      turnCount: 1,
      worldbook: [worldbook],
      memories,
      userDoc,
      sceneDoc,
      maxChars: 120,
    });
    expect(block.length).toBeLessThanOrEqual(120);
    expect(block).toContain("[检索上下文");
  });

  it("uses quoted text for worldbook matching and transcript marking", () => {
    const message: PluginMessage = {
      id: "m2",
      chat: { type: "private", userId: 20000, chatKey: "private:20000" },
      userId: 20000,
      senderName: "鱼片",
      text: "那今天呢？",
      images: [],
      mentionsBot: false,
      receivedAt: Date.now(),
      quote: {
        id: "m1",
        userId: 20000,
        senderName: "鱼片",
        receivedAt: Date.now(),
        text: "我上周说想吃白饭",
        images: [],
        unsupported: [],
        available: true,
      },
    };
    const query = promptQueryText(message);
    expect(query).toContain("白饭");
    expect(query).toContain("那今天呢");
    const selected = selectWorldbook(
      [worldbook],
      { currentText: query, recentTexts: [] },
      { scanDepth: 0, maxEntries: 10, maxChars: 2000 },
    );
    expect(selected.map((entry) => entry.name)).toContain("白饭执念");

    const stored = transcriptUserText("那今天呢？", message.quote ?? null);
    expect(stored).toContain("[引用 鱼片]");
    expect(stored).toContain("我上周说想吃白饭");
    expect(stored).toContain("那今天呢？");
    expect(stored.indexOf("我上周说想吃白饭")).toBeLessThan(stored.indexOf("那今天呢？"));
  });
});
