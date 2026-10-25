import Database from "better-sqlite3";
import { buildFtsQuery, buildPhraseQuery, escapeLike } from "./retrieval.js";

export type MemoryRole = "user" | "assistant";

export interface MemoryMessageInput {
  namespace: string;
  chatKey: string;
  scope: string;
  role: MemoryRole;
  speaker: string;
  text: string;
  ts: number;
  qqMessageId?: string;
  sessionId?: string;
  actorQq?: number;
}

export interface MemoryMessage {
  id: number;
  role: MemoryRole;
  speaker: string;
  text: string;
  ts: number;
  actorQq: number | null;
}

export interface MemorySnippet {
  id: number;
  role: MemoryRole;
  speaker: string;
  text: string;
  ts: number;
}

export interface MemorySearchInput {
  namespace: string;
  scope: string;
  query: string;
  limit: number;
  /** Rows already present in the live OpenCode window. */
  excludeIds?: number[];
}

export interface MemoryEventInput {
  namespace: string;
  scope: string;
  actorQq: number;
  action: string;
  summary: string;
  detail?: Record<string, unknown> | null;
  sourceMessageId?: number | null;
  now?: number;
}

export interface MemoryEvent {
  id: number;
  namespace: string;
  scope: string;
  actorQq: number;
  action: string;
  summary: string;
  detail: Record<string, unknown> | null;
  sourceMessageId: number | null;
  createdAt: number;
}

interface MessageRow {
  id: number;
  role: MemoryRole;
  speaker: string;
  text: string;
  ts: number;
  actorQq: number | null;
}

interface EventRow {
  id: number;
  namespace: string;
  scope: string;
  actorQq: number;
  action: string;
  summary: string;
  detailJson: string | null;
  sourceMessageId: number | null;
  createdAt: number;
}

/**
 * Raw transcript + derivation audit. The store is namespace-agnostic: callers
 * pass a persona/project/plugin namespace plus a chat scope. Domain policy such
 * as persona bindings and consolidation prompts lives outside this package.
 */
export class TranscriptStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#createBaseSchema();
    this.#migrate();
  }

  #createBaseSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        qq_message_id TEXT,
        session_id TEXT,
        actor_qq INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='trigram');
    `);
  }

  #migrate(): void {
    const messageColumns = this.#db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
    }>;
    if (
      messageColumns.some((column) => column.name === "persona_id") &&
      !messageColumns.some((column) => column.name === "namespace")
    ) {
      this.#db.exec("ALTER TABLE messages RENAME COLUMN persona_id TO namespace");
    }
    if (!messageColumns.some((column) => column.name === "actor_qq")) {
      this.#db.exec("ALTER TABLE messages ADD COLUMN actor_qq INTEGER");
    }

    const eventTable = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_events'")
      .get() as { name: string } | undefined;
    if (eventTable !== undefined) {
      const eventColumns = this.#db.prepare("PRAGMA table_info(memory_events)").all() as Array<{
        name: string;
      }>;
      if (
        eventColumns.some((column) => column.name === "persona_id") &&
        !eventColumns.some((column) => column.name === "namespace")
      ) {
        this.#db.exec("ALTER TABLE memory_events RENAME COLUMN persona_id TO namespace");
      }
    }

    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS messages_scope_ts ON messages (scope, ts DESC);
      CREATE INDEX IF NOT EXISTS messages_namespace_scope ON messages (namespace, scope);
      CREATE INDEX IF NOT EXISTS messages_recent ON messages (chat_key, namespace, id DESC);
      CREATE INDEX IF NOT EXISTS messages_scope_id ON messages (namespace, scope, id DESC);
      CREATE INDEX IF NOT EXISTS messages_actor
        ON messages (namespace, scope, actor_qq, id DESC);
      DROP TABLE IF EXISTS facts;
      DROP TABLE IF EXISTS episodes;
      DROP TABLE IF EXISTS episodes_fts;
      DROP TABLE IF EXISTS memory_state;
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        scope TEXT NOT NULL,
        actor_qq INTEGER NOT NULL DEFAULT 0,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail_json TEXT,
        source_message_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_events_scope
        ON memory_events (namespace, scope, created_at DESC, id DESC);
    `);
    this.#db.pragma("user_version = 1");
  }

  addMessage(input: MemoryMessageInput): number {
    const result = this.#db
      .prepare(
        `INSERT INTO messages
           (namespace, chat_key, scope, role, speaker, text, ts, qq_message_id, session_id, actor_qq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        input.chatKey,
        input.scope,
        input.role,
        input.speaker,
        input.text,
        input.ts,
        input.qqMessageId ?? null,
        input.sessionId ?? null,
        input.actorQq ?? null,
      );
    const id = Number(result.lastInsertRowid);
    this.#db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(id, input.text);
    return id;
  }

  recent(chatKey: string, limit: number, namespace?: string): MemorySnippet[] {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const rows = (
      namespace === undefined
        ? this.#db
            .prepare(
              "SELECT id, role, speaker, text, ts, actor_qq AS actorQq FROM messages WHERE chat_key = ? ORDER BY id DESC LIMIT ?",
            )
            .all(chatKey, max)
        : this.#db
            .prepare(
              "SELECT id, role, speaker, text, ts, actor_qq AS actorQq FROM messages WHERE chat_key = ? AND namespace = ? ORDER BY id DESC LIMIT ?",
            )
            .all(chatKey, namespace, max)
    ) as MessageRow[];
    return rows.reverse().map(toSnippet);
  }

  /**
   * Keyword search over the raw transcript. Phrase first (exact substring),
   * then CJK trigram OR, then LIKE for short queries.
   */
  search(input: MemorySearchInput): MemorySnippet[] {
    const query = input.query.trim();
    if (query.length === 0) return [];
    const limit = Math.max(1, Math.floor(input.limit));
    const exclude = input.excludeIds ?? [];
    const exclusion =
      exclude.length > 0 ? ` AND m.id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
    const fetchLimit = Math.max(limit * 4, limit);
    const seen = new Set<number>();
    const rows: MessageRow[] = [];

    const collect = (candidates: MessageRow[]): void => {
      for (const row of candidates) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    };

    const phrase = buildPhraseQuery(query);
    if (phrase !== null && query.length >= 3) {
      try {
        collect(
          this.#db
            .prepare(
              `SELECT m.id, m.role, m.speaker, m.text, m.ts, m.actor_qq AS actorQq
               FROM messages_fts f
               JOIN messages m ON m.id = f.rowid
               WHERE messages_fts MATCH ?
                 AND m.namespace = ?
                 AND m.scope = ?
                 ${exclusion}
               ORDER BY bm25(messages_fts), m.ts DESC
               LIMIT ?`,
            )
            .all(phrase, input.namespace, input.scope, ...exclude, fetchLimit) as MessageRow[],
        );
      } catch {
        // Punctuation-heavy queries can be invalid FTS phrases; keep going.
      }
    }

    const fts = buildFtsQuery(query);
    if (fts !== null && fts !== phrase) {
      try {
        collect(
          this.#db
            .prepare(
              `SELECT m.id, m.role, m.speaker, m.text, m.ts, m.actor_qq AS actorQq
               FROM messages_fts f
               JOIN messages m ON m.id = f.rowid
               WHERE messages_fts MATCH ?
                 AND m.namespace = ?
                 AND m.scope = ?
                 ${exclusion}
               ORDER BY bm25(messages_fts), m.ts DESC
               LIMIT ?`,
            )
            .all(fts, input.namespace, input.scope, ...exclude, fetchLimit) as MessageRow[],
        );
      } catch {
        // Fall through to LIKE.
      }
    }

    if (rows.length === 0) {
      const pattern = `%${escapeLike(query)}%`;
      collect(
        this.#db
          .prepare(
            `SELECT m.id, m.role, m.speaker, m.text, m.ts, m.actor_qq AS actorQq
             FROM messages m
             WHERE m.namespace = ?
               AND m.scope = ?
               ${exclusion}
               AND m.text LIKE ? ESCAPE '\\'
             ORDER BY m.ts DESC
             LIMIT ?`,
          )
          .all(input.namespace, input.scope, ...exclude, pattern, fetchLimit) as MessageRow[],
      );
    }

    return rows.slice(0, limit).map(toSnippet);
  }

  count(scope: string, namespace?: string, role?: MemoryRole): number {
    const conditions = ["scope = ?"];
    const params: Array<string> = [scope];
    if (namespace !== undefined) {
      conditions.push("namespace = ?");
      params.push(namespace);
    }
    if (role !== undefined) {
      conditions.push("role = ?");
      params.push(role);
    }
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM messages WHERE ${conditions.join(" AND ")}`)
      .get(...params) as { total: number };
    return row.total;
  }

  countUserMessagesAfter(chatKey: string, namespace: string, afterId: number): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE chat_key = ? AND namespace = ? AND role = 'user' AND id > ?",
      )
      .get(chatKey, namespace, afterId) as { total: number };
    return row.total;
  }

  latestMessageId(chatKey: string, namespace: string): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE chat_key = ? AND namespace = ?",
      )
      .get(chatKey, namespace) as { id: number };
    return row.id;
  }

  messagesTail(input: {
    chatKey: string;
    namespace: string;
    limit: number;
  }): MemoryMessage[] {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, role, speaker, text, ts, actor_qq AS actorQq
         FROM messages WHERE chat_key = ? AND namespace = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(input.chatKey, input.namespace, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /**
   * Recent window for one actor: their messages plus assistant replies. Used
   * for per-user documents in shared groups so another member's facts are not
   * written into the wrong document.
   */
  messagesTailForActor(input: {
    chatKey: string;
    namespace: string;
    actorQq: number;
    limit: number;
  }): MemoryMessage[] {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, role, speaker, text, ts, actor_qq AS actorQq
         FROM messages
         WHERE chat_key = ? AND namespace = ?
           AND (role = 'assistant' OR actor_qq = ? OR actor_qq IS NULL)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(input.chatKey, input.namespace, input.actorQq, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  messagesAfter(input: {
    chatKey: string;
    namespace: string;
    afterId: number;
    limit: number;
  }): MemoryMessage[] {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, role, speaker, text, ts, actor_qq AS actorQq
         FROM messages WHERE chat_key = ? AND namespace = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(input.chatKey, input.namespace, input.afterId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  addMemoryEvent(input: MemoryEventInput): number {
    const now = input.now ?? Date.now();
    const result = this.#db
      .prepare(
        `INSERT INTO memory_events
           (namespace, scope, actor_qq, action, summary, detail_json, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        input.scope,
        input.actorQq,
        input.action,
        input.summary,
        input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
        input.sourceMessageId ?? null,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  listMemoryEvents(scope: string, namespace: string, limit = 10): MemoryEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT id, namespace AS namespace, scope, actor_qq AS actorQq, action, summary,
                detail_json AS detailJson, source_message_id AS sourceMessageId,
                created_at AS createdAt
         FROM memory_events
         WHERE namespace = ? AND scope = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(namespace, scope, Math.max(1, Math.floor(limit))) as EventRow[];
    return rows.map(toEvent);
  }

  latestMemoryEvent(scope: string, namespace: string): MemoryEvent | null {
    const rows = this.listMemoryEvents(scope, namespace, 1);
    return rows[0] ?? null;
  }

  lastConsolidatedMessageId(scope: string, namespace: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(source_message_id), 0) AS id
         FROM memory_events WHERE namespace = ? AND scope = ?`,
      )
      .get(namespace, scope) as { id: number };
    return row.id;
  }

  countMemoryEvents(scope: string, namespace: string): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS total FROM memory_events WHERE namespace = ? AND scope = ?",
      )
      .get(namespace, scope) as { total: number };
    return row.total;
  }

  forgetMessages(chatKey: string, namespace: string): number {
    const transaction = this.#db.transaction(() => {
      const ids = this.#db
        .prepare("SELECT id FROM messages WHERE chat_key = ? AND namespace = ?")
        .all(chatKey, namespace) as Array<{ id: number }>;
      const removeFts = this.#db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
      const removeRow = this.#db.prepare("DELETE FROM messages WHERE id = ?");
      for (const { id } of ids) {
        removeFts.run(id);
        removeRow.run(id);
      }
      return ids.length;
    });
    return transaction();
  }

  forgetScope(chatKey: string, namespace: string): { messages: number; events: number } {
    const transaction = this.#db.transaction(() => {
      const messages = this.forgetMessages(chatKey, namespace);
      const events = this.#db
        .prepare("DELETE FROM memory_events WHERE namespace = ? AND scope = ?")
        .run(namespace, chatKey).changes;
      return { messages, events };
    });
    return transaction();
  }

  close(): void {
    this.#db.close();
  }
}

function toSnippet(row: MessageRow): MemorySnippet {
  return { id: row.id, role: row.role, speaker: row.speaker, text: row.text, ts: row.ts };
}

function toMessage(row: MessageRow): MemoryMessage {
  return {
    id: row.id,
    role: row.role,
    speaker: row.speaker,
    text: row.text,
    ts: row.ts,
    actorQq: row.actorQq,
  };
}

function toEvent(row: EventRow): MemoryEvent {
  let detail: Record<string, unknown> | null = null;
  if (row.detailJson !== null) {
    try {
      const parsed: unknown = JSON.parse(row.detailJson);
      detail =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    namespace: row.namespace,
    scope: row.scope,
    actorQq: row.actorQq,
    action: row.action,
    summary: row.summary,
    detail,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt,
  };
}
