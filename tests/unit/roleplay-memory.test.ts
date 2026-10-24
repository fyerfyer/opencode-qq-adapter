import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../packages/roleplay/src/memory.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-rp-memory-"));
  return new MemoryStore(join(root, "memory.db"));
}

describe("roleplay memory store", () => {
  it("stores transcript rows and retrieves short Chinese queries with LIKE", async () => {
    const store = await setup();
    store.addMessage({
      personaId: "blue-fat-fish",
      chatKey: "private:20000",
      scope: "private:20000",
      role: "user",
      speaker: "鱼片",
      text: "上周三我们一起去了海边。",
      ts: 1,
    });
    store.addMessage({
      personaId: "blue-fat-fish",
      chatKey: "private:20000",
      scope: "private:20000",
      role: "assistant",
      speaker: "蓝色大肥鱼",
      text: "我才没有想再去一次。",
      ts: 2,
    });

    const hits = store.search({
      personaId: "blue-fat-fish",
      scope: "private:20000",
      query: "海边",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ role: "user", speaker: "鱼片" });
    store.close();
  });

  it("retrieves three-character Chinese queries through FTS", async () => {
    const store = await setup();
    store.addMessage({
      personaId: "blue-fat-fish",
      chatKey: "private:20000",
      scope: "private:20000",
      role: "user",
      speaker: "鱼片",
      text: "今天想吃白米饭。",
      ts: 1,
    });
    const hits = store.search({
      personaId: "blue-fat-fish",
      scope: "private:20000",
      query: "白米饭",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
    store.close();
  });

  it("isolates scopes and honors excluded message ids", async () => {
    const store = await setup();
    const first = store.addMessage({
      personaId: "blue-fat-fish",
      chatKey: "private:20000",
      scope: "private:20000",
      role: "user",
      speaker: "鱼片",
      text: "白米饭真好吃。",
      ts: 1,
    });
    store.addMessage({
      personaId: "blue-fat-fish",
      chatKey: "group:30001",
      scope: "group:30001",
      role: "user",
      speaker: "群友",
      text: "白米饭真好吃。",
      ts: 2,
    });

    const isolated = store.search({
      personaId: "blue-fat-fish",
      scope: "group:30001",
      query: "白米饭",
      limit: 5,
    });
    expect(isolated).toHaveLength(1);
    expect(isolated[0]?.speaker).toBe("群友");

    const excluded = store.search({
      personaId: "blue-fat-fish",
      scope: "private:20000",
      query: "白米饭",
      limit: 5,
      excludeIds: [first],
    });
    expect(excluded).toHaveLength(0);
    store.close();
  });

  it("returns recent messages chronologically and deletes a scope", async () => {
    const store = await setup();
    for (const [index, text] of ["第一句", "第二句", "第三句"].entries()) {
      store.addMessage({
        personaId: "blue-fat-fish",
        chatKey: "private:20000",
        scope: "private:20000",
        role: index % 2 === 0 ? "user" : "assistant",
        speaker: index % 2 === 0 ? "鱼片" : "蓝色大肥鱼",
        text,
        ts: index,
      });
    }
    expect(store.recent("private:20000", 2).map((row) => row.text)).toEqual(["第二句", "第三句"]);
    expect(store.count("private:20000")).toBe(3);
    expect(store.forget({ personaId: "blue-fat-fish", scope: "private:20000" })).toBe(3);
    expect(store.count("private:20000")).toBe(0);
    expect(
      store.search({
        personaId: "blue-fat-fish",
        scope: "private:20000",
        query: "第二句",
        limit: 5,
      }),
    ).toEqual([]);
    store.close();
  });
});
