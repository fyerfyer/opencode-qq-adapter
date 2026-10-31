import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TranscriptStore } from "../../packages/memory/src/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-rp-transcript-"));
  return new TranscriptStore(join(root, "roleplay.db"));
}

describe("roleplay transcript store", () => {
  it("stores messages, isolates scopes and retrieves short Chinese queries with LIKE", async () => {
    const store = await setup();
    store.addMessage({
      namespace: "p",
      chatKey: "private:1",
      scope: "private:1",
      role: "user",
      speaker: "鱼片",
      text: "上周三我们一起去了海边。",
      ts: 1,
      actorQq: 1,
    });
    store.addMessage({
      namespace: "p",
      chatKey: "group:9",
      scope: "group:9",
      role: "user",
      speaker: "群友",
      text: "海边风很大。",
      ts: 2,
      actorQq: 2,
    });

    const hits = store.search({
      namespace: "p",
      scope: "private:1",
      query: "海边",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain("上周三");
    store.close();
  });

  it("retrieves natural-language Chinese queries through trigram OR", async () => {
    const store = await setup();
    store.addMessage({
      namespace: "p",
      chatKey: "private:1",
      scope: "private:1",
      role: "user",
      speaker: "鱼片",
      text: "我讨厌香菜。",
      ts: 1,
      actorQq: 1,
    });
    const hits = store.search({
      namespace: "p",
      scope: "private:1",
      query: "我上次说我讨厌什么来着",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain("香菜");
    store.close();
  });

  it("returns messages chronologically and filters excluded ids", async () => {
    const store = await setup();
    for (const [index, text] of ["第一句", "第二句", "第三句"].entries()) {
      store.addMessage({
        namespace: "p",
        chatKey: "private:1",
        scope: "private:1",
        role: index % 2 === 0 ? "user" : "assistant",
        speaker: index % 2 === 0 ? "鱼片" : "角色",
        text,
        ts: index,
      });
    }
    expect(store.recent("private:1", 2).map((row) => row.text)).toEqual(["第二句", "第三句"]);
    expect(
      store.messagesTail({ chatKey: "private:1", namespace: "p", limit: 2 }).map((m) => m.text),
    ).toEqual(["第二句", "第三句"]);
    expect(
      store.search({
        namespace: "p",
        scope: "private:1",
        query: "第三句",
        limit: 5,
        excludeIds: [3],
      }),
    ).toEqual([]);
    expect(store.count("private:1", "p", "user")).toBe(2);
    store.close();
  });

  it("filters a shared-group window to one actor plus assistant replies", async () => {
    const store = await setup();
    for (const [role, speaker, text, actor] of [
      ["user", "一号", "一号说话", 1],
      ["user", "二号", "二号说话", 2],
      ["assistant", "角色", "回复二号", null],
    ] as const) {
      store.addMessage({
        namespace: "p",
        chatKey: "group:9",
        scope: "group:9",
        role,
        speaker,
        text,
        ts: 1,
        actorQq: actor ?? undefined,
      });
    }
    expect(
      store
        .messagesTailForActor({ chatKey: "group:9", namespace: "p", actorQq: 1, limit: 10 })
        .map((message) => message.text),
    ).toEqual(["一号说话", "回复二号"]);
    store.close();
  });

  it("tracks consolidation events and cursors", async () => {
    const store = await setup();
    const first = store.addMessage({
      namespace: "p",
      chatKey: "private:1",
      scope: "private:1",
      role: "user",
      speaker: "鱼片",
      text: "你好",
      ts: 1,
      actorQq: 1,
    });
    const event = store.addMemoryEvent({
      namespace: "p",
      scope: "private:1",
      actorQq: 1,
      action: "consolidate",
      summary: "无变化",
      sourceMessageId: first,
    });
    expect(event).toBeGreaterThan(0);
    expect(store.lastConsolidatedMessageId("private:1", "p")).toBe(first);
    expect(store.countMemoryEvents("private:1", "p")).toBe(1);
    expect(store.latestMemoryEvent("private:1", "p")).toMatchObject({
      action: "consolidate",
      summary: "无变化",
    });
    store.close();
  });

  it("forgets messages and events for a scope", async () => {
    const store = await setup();
    store.addMessage({
      namespace: "p",
      chatKey: "private:1",
      scope: "private:1",
      role: "user",
      speaker: "鱼片",
      text: "你好",
      ts: 1,
      actorQq: 1,
    });
    store.addMemoryEvent({
      namespace: "p",
      scope: "private:1",
      actorQq: 1,
      action: "consolidate",
      summary: "更新",
    });
    expect(store.forgetScope("private:1", "p")).toEqual({ messages: 1, events: 1 });
    expect(store.count("private:1", "p")).toBe(0);
    expect(store.countMemoryEvents("private:1", "p")).toBe(0);
    store.close();
  });

  it("migrates an old facts/episodes database without losing raw messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-rp-transcript-migrate-"));
    const path = join(root, "roleplay.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        role TEXT NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        qq_message_id TEXT,
        session_id TEXT
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, tokenize='trigram');
      CREATE TABLE bindings (
        chat_key TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        previous_project_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE facts (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE episodes (id INTEGER PRIMARY KEY, summary TEXT);
      CREATE TABLE memory_state (id INTEGER PRIMARY KEY);
    `);
    const inserted = db
      .prepare(
        "INSERT INTO messages (persona_id, chat_key, scope, role, speaker, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("p", "private:1", "private:1", "user", "鱼片", "我喜欢白米饭", 1);
    db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(
      inserted.lastInsertRowid,
      "我喜欢白米饭",
    );
    db.close();

    const store = new TranscriptStore(path);
    expect(store.count("private:1", "p")).toBe(1);
    store.addMemoryEvent({
      namespace: "p",
      scope: "private:1",
      actorQq: 1,
      action: "consolidate",
      summary: "迁移后可用",
    });
    store.close();
  });
});
