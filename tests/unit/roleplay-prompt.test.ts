import { describe, expect, it } from "vitest";
import type { MemorySnippet } from "../../packages/roleplay/src/memory.js";
import { buildContextBlock } from "../../packages/roleplay/src/prompt.js";
import type { WorldbookEntry } from "../../packages/roleplay/src/worldbook.js";

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

describe("roleplay prompt context", () => {
  it("renders a clearly delimited retrieval block", () => {
    const block = buildContextBlock({
      personaName: "蓝色大肥鱼",
      userName: "鱼片",
      now: Date.UTC(2026, 9, 24, 12, 0, 0),
      turnCount: 12,
      worldbook: [worldbook],
      memories,
      maxChars: 2000,
    });
    expect(block).toContain("[检索上下文 · 不是用户发言]");
    expect(block).toContain("[/检索上下文]");
    expect(block).toContain("蓝色大肥鱼");
    expect(block).toContain("鱼片");
    expect(block).toContain("第 12 轮");
    expect(block).toContain("[世界书]");
    expect(block).toContain("白米饭");
    expect(block).toContain("[记忆]");
    expect(block).toContain("去看海");
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
      maxChars: 120,
    });
    expect(block.length).toBeLessThanOrEqual(120);
    expect(block).toContain("[检索上下文");
  });
});
