import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  type MemoryDocumentConfig,
  MemoryDocumentStore,
  safeMemorySegment,
  TranscriptStore,
} from "../../packages/memory/src/index.js";

describe("memory package transcript", () => {
  it("migrates a legacy persona_id database to namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-memory-package-"));
    const path = join(root, "memory.db");
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
      CREATE TABLE memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        actor_qq INTEGER NOT NULL DEFAULT 0,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail_json TEXT,
        source_message_id INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    const inserted = db
      .prepare(
        "INSERT INTO messages (persona_id, chat_key, scope, role, speaker, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("blue", "private:1", "private:1", "user", "鱼片", "我喜欢白米饭", 1);
    db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(
      inserted.lastInsertRowid,
      "我喜欢白米饭",
    );
    db.close();

    const store = new TranscriptStore(path);
    expect(store.count("private:1", "blue")).toBe(1);
    expect(
      store.search({ namespace: "blue", scope: "private:1", query: "白米饭", limit: 5 }),
    ).toHaveLength(1);
    store.addMemoryEvent({
      namespace: "blue",
      scope: "private:1",
      actorQq: 1,
      action: "consolidate",
      summary: "迁移后可用",
    });
    expect(store.countMemoryEvents("private:1", "blue")).toBe(1);
    store.close();
  });
});

describe("memory package documents", () => {
  const config: MemoryDocumentConfig = {
    user: { title: "Notes", sections: ["profile", "manual"], manualSection: "manual" },
    scene: { title: "Scene", sections: ["events"], manualSection: "manual" },
    isShared(scope) {
      return scope.startsWith("shared:");
    },
    paths(root, ref) {
      const baseDir = join(root, safeMemorySegment(ref.namespace), safeMemorySegment(ref.scope));
      const shared = scopeIsShared(ref.scope);
      return {
        shared,
        baseDir,
        historyDir: join(baseDir, "history"),
        userPath: shared
          ? join(baseDir, "users", `${ref.actorQq}.md`)
          : join(baseDir, `${ref.actorQq}.md`),
        scenePath: shared ? join(baseDir, "scene.md") : null,
      };
    },
  };

  it("writes, versions and manually appends documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-memory-docs-"));
    const store = new MemoryDocumentStore({ root, config });
    const ref = { namespace: "notes", scope: "private:1", actorQq: 1 };
    const first = await store.writeUser(ref, "# Notes\n\n## profile\n- 喜欢白饭\n");
    expect(first.exists).toBe(true);
    const manual = await store.appendManual(ref, "生日是 3 月 14 日");
    expect(manual.content).toContain("## manual\n- 生日是 3 月 14 日");
    expect(await store.history(ref, "user")).toHaveLength(1);
    const loaded = await store.load(ref);
    expect(loaded.user.content).toContain("喜欢白饭");
    expect(loaded.shared).toBe(false);
  });

  it("writes shared scene and per-user documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-memory-shared-"));
    const store = new MemoryDocumentStore({ root, config });
    const ref = { namespace: "notes", scope: "shared:9", actorQq: 2 };
    await store.writeScene(ref, "# Scene\n\n## events\n- 一起去看了海\n");
    await store.writeUser(ref, "# Notes\n\n## profile\n- 二号群友\n");
    const loaded = await store.load(ref);
    expect(loaded.shared).toBe(true);
    expect(loaded.scene?.content).toContain("一起去看了海");
    expect(loaded.user.path).toContain("users/2.md");
  });
});

function scopeIsShared(scope: string): boolean {
  return scope.startsWith("shared:");
}
