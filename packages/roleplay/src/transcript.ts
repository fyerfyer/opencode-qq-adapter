import Database from "better-sqlite3";
import { buildFtsQuery, buildPhraseQuery, escapeLike } from "./retrieval.js";

export type MemoryRole = "user" | "assistant";

export interface BindingRecord {
  chatKey: string;
  personaId: string;
  previousProjectId: string | null;
  enabled: boolean;
  updatedAt: number;
}

export interface MemoryMessageInput {
  personaId: string;
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
  personaId: string;
  scope: string;
  query: string;
  limit: number;
  /** Rows already present in the live OpenCode window. */
  excludeIds?: number[];
}

export interface MemoryEventInput {
  personaId: string;
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
  personaId: string;
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
  personaId: string;
  scope: string;
  actorQq: number;
  action: string;
  summary: string;
  detailJson: string | null;
  sourceMessageId: number | null;
  createdAt: number;
}

const SCHEMA_VERSION = 3;

/**
 * Raw transcript + derivation audit. This store deliberately has no knowledge
 * of "facts": memory policy lives in the Markdown document service.
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
        persona_id TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS messages_scope_ts ON messages (scope, ts DESC);
      CREATE INDEX IF NOT EXISTS messages_persona_scope ON messages (persona_id, scope);
      CREATE INDEX IF NOT EXISTS messages_recent ON messages (chat_key, persona_id, id DESC);
      CREATE INDEX IF NOT EXISTS messages_scope_id ON messages (persona_id, scope, id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS bindings (
        chat_key TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        previous_project_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  #migrate(): void {
    const version = this.#db.pragma("user_version", { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;

    const messageColumns = this.#db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
    }>;
    if (!messageColumns.some((column) => column.name === "actor_qq")) {
      this.#db.exec("ALTER TABLE messages ADD COLUMN actor_qq INTEGER");
    }
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS messages_actor
        ON messages (persona_id, scope, actor_qq, id DESC);
      DROP TABLE IF EXISTS facts;
      DROP TABLE IF EXISTS episodes;
      DROP TABLE IF EXISTS episodes_fts;
      DROP TABLE IF EXISTS memory_state;
      CREATE TABLE IF NOT EXISTS memory_events (
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
      CREATE INDEX IF NOT EXISTS memory_events_scope
        ON memory_events (persona_id, scope, created_at DESC, id DESC);
    `);
    this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  getBinding(chatKey: string): BindingRecord | null {
    const row = this.#db
      .prepare(
        "SELECT chat_key AS chatKey, persona_id AS personaId, previous_project_id AS previousProjectId, enabled, updated_at AS updatedAt FROM bindings WHERE chat_key = ?",
      )
      .get(chatKey) as
      | {
          chatKey: string;
          personaId: string;
          previousProjectId: string | null;
          enabled: number;
          updatedAt: number;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      chatKey: row.chatKey,
      personaId: row.personaId,
      previousProjectId: row.previousProjectId,
      enabled: row.enabled === 1,
      updatedAt: row.updatedAt,
    };
  }

  setBinding(input: BindingRecord): void {
    this.#db
      .prepare(
        `INSERT INTO bindings (chat_key, persona_id, previous_project_id, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_key) DO UPDATE SET
           persona_id = excluded.persona_id,
           previous_project_id = excluded.previous_project_id,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.chatKey,
        input.personaId,
        input.previousProjectId,
        input.enabled ? 1 : 0,
        input.updatedAt,
      );
  }

  addMessage(input: MemoryMessageInput): number {
    const result = this.#db
      .prepare(
        `INSERT INTO messages
           (persona_id, chat_key, scope, role, speaker, text, ts, qq_message_id, session_id, actor_qq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.personaId,
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

  recent(chatKey: string, limit: number, personaId?: string): MemorySnippet[] {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const rows = (
      personaId === undefined
        ? this.#db
            .prepare(
              "SELECT id, role, speaker, text, ts, actor_qq AS actorQq FROM messages WHERE chat_key = ? ORDER BY id DESC LIMIT ?",
            )
            .all(chatKey, max)
        : this.#db
            .prepare(
              "SELECT id, role, speaker, text, ts, actor_qq AS actorQq FROM messages WHERE chat_key = ? AND persona_id = ? ORDER BY id DESC LIMIT ?",
            )
            .all(chatKey, personaId, max)
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
                 AND m.persona_id = ?
                 AND m.scope = ?
                 ${exclusion}
               ORDER BY bm25(messages_fts), m.ts DESC
               LIMIT ?`,
            )
            .all(phrase, input.personaId, input.scope, ...exclude, fetchLimit) as MessageRow[],
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
                 AND m.persona_id = ?
                 AND m.scope = ?
                 ${exclusion}
               ORDER BY bm25(messages_fts), m.ts DESC
               LIMIT ?`,
            )
            .all(fts, input.personaId, input.scope, ...exclude, fetchLimit) as MessageRow[],
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
             WHERE m.persona_id = ?
               AND m.scope = ?
               ${exclusion}
               AND m.text LIKE ? ESCAPE '\\'
             ORDER BY m.ts DESC
             LIMIT ?`,
          )
          .all(input.personaId, input.scope, ...exclude, pattern, fetchLimit) as MessageRow[],
      );
    }

    return rows.slice(0, limit).map(toSnippet);
  }

  count(scope: string, personaId?: string, role?: MemoryRole): number {
    const conditions = ["scope = ?"];
    const params: Array<string> = [scope];
    if (personaId !== undefined) {
      conditions.push("persona_id = ?");
      params.push(personaId);
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

  countUserMessagesAfter(chatKey: string, personaId: string, afterId: number): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE chat_key = ? AND persona_id = ? AND role = 'user' AND id > ?",
      )
      .get(chatKey, personaId, afterId) as { total: number };
    return row.total;
  }

  latestMessageId(chatKey: string, personaId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE chat_key = ? AND persona_id = ?",
      )
      .get(chatKey, personaId) as { id: number };
    return row.id;
  }

  messagesTail(input: {
    chatKey: string;
    personaId: string;
    limit: number;
  }): MemoryMessage[] {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, role, speaker, text, ts, actor_qq AS actorQq
         FROM messages WHERE chat_key = ? AND persona_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(input.chatKey, input.personaId, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /**
   * Recent window for one actor: their messages plus assistant replies. Used
   * for per-user documents in shared groups so another member's facts are not
   * written into the wrong document.
   */
  messagesTailForActor(input: {
    chatKey: string;
    personaId: string;
    actorQq: number;
    limit: number;
  }): MemoryMessage[] {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, role, speaker, text, ts, actor_qq AS actorQq
         FROM messages
         WHERE chat_key = ? AND persona_id = ?
           AND (role = 'assistant' OR actor_qq = ? OR actor_qq IS NULL)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(input.chatKey, input.personaId, input.actorQq, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  messagesAfter(input: {
    chatKey: string;
    personaId: string;
    afterId: number;
    limit: number;
  }): MemoryMessage[] {
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT id, role, speaker, text, ts, actor_qq AS actorQq
         FROM messages WHERE chat_key = ? AND persona_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(input.chatKey, input.personaId, input.afterId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  addMemoryEvent(input: MemoryEventInput): number {
    const now = input.now ?? Date.now();
    const result = this.#db
      .prepare(
        `INSERT INTO memory_events
           (persona_id, scope, actor_qq, action, summary, detail_json, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.personaId,
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

  listMemoryEvents(scope: string, personaId: string, limit = 10): MemoryEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT id, persona_id AS personaId, scope, actor_qq AS actorQq, action, summary,
                detail_json AS detailJson, source_message_id AS sourceMessageId,
                created_at AS createdAt
         FROM memory_events
         WHERE persona_id = ? AND scope = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(personaId, scope, Math.max(1, Math.floor(limit))) as EventRow[];
    return rows.map(toEvent);
  }

  latestMemoryEvent(scope: string, personaId: string): MemoryEvent | null {
    const rows = this.listMemoryEvents(scope, personaId, 1);
    return rows[0] ?? null;
  }

  lastConsolidatedMessageId(scope: string, personaId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(source_message_id), 0) AS id
         FROM memory_events WHERE persona_id = ? AND scope = ?`,
      )
      .get(personaId, scope) as { id: number };
    return row.id;
  }

  countMemoryEvents(scope: string, personaId: string): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS total FROM memory_events WHERE persona_id = ? AND scope = ?",
      )
      .get(personaId, scope) as { total: number };
    return row.total;
  }

  forgetMessages(chatKey: string, personaId: string): number {
    const transaction = this.#db.transaction(() => {
      const ids = this.#db
        .prepare("SELECT id FROM messages WHERE chat_key = ? AND persona_id = ?")
        .all(chatKey, personaId) as Array<{ id: number }>;
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

  forgetScope(chatKey: string, personaId: string): { messages: number; events: number } {
    const transaction = this.#db.transaction(() => {
      const messages = this.forgetMessages(chatKey, personaId);
      const events = this.#db
        .prepare("DELETE FROM memory_events WHERE persona_id = ? AND scope = ?")
        .run(personaId, chatKey).changes;
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
    personaId: row.personaId,
    scope: row.scope,
    actorQq: row.actorQq,
    action: row.action,
    summary: row.summary,
    detail,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt,
  };
}
