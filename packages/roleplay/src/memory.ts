import Database from "better-sqlite3";

export type MemoryRole = "user" | "assistant";

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
}

export interface MemorySearchInput {
  personaId: string;
  scope: string;
  query: string;
  limit: number;
  /** Rows already present in the live OpenCode window. */
  excludeIds?: number[];
}

export interface MemorySnippet {
  id: number;
  role: MemoryRole;
  speaker: string;
  text: string;
  ts: number;
}

export interface BindingRecord {
  chatKey: string;
  personaId: string;
  previousProjectId: string | null;
  enabled: boolean;
  updatedAt: number;
}

interface MessageRow {
  id: number;
  role: MemoryRole;
  speaker: string;
  text: string;
  ts: number;
}

/**
 * Raw transcript memory for roleplay. M1 deliberately stores messages rather
 * than LLM summaries; retrieval is deterministic and cheap.
 */
export class MemoryStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
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
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_scope_ts ON messages (scope, ts DESC);
      CREATE INDEX IF NOT EXISTS messages_persona_scope ON messages (persona_id, scope);
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
    const insert = this.#db.prepare(`
      INSERT INTO messages (persona_id, chat_key, scope, role, speaker, text, ts, qq_message_id, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      input.personaId,
      input.chatKey,
      input.scope,
      input.role,
      input.speaker,
      input.text,
      input.ts,
      input.qqMessageId ?? null,
      input.sessionId ?? null,
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
              "SELECT id, role, speaker, text, ts FROM messages WHERE chat_key = ? ORDER BY id DESC LIMIT ?",
            )
            .all(chatKey, max)
        : this.#db
            .prepare(
              "SELECT id, role, speaker, text, ts FROM messages WHERE chat_key = ? AND persona_id = ? ORDER BY id DESC LIMIT ?",
            )
            .all(chatKey, personaId, max)
    ) as MessageRow[];
    return rows.reverse().map(toSnippet);
  }

  search(input: MemorySearchInput): MemorySnippet[] {
    const query = input.query.trim();
    if (query.length === 0) return [];
    const limit = Math.max(1, Math.floor(input.limit));
    const exclude = input.excludeIds ?? [];
    const exclusion =
      exclude.length > 0 ? ` AND m.id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
    const params = [input.personaId, input.scope, ...exclude, limit];

    if (query.length >= 3) {
      try {
        const phrase = `"${query.replace(/"/g, '""')}"`;
        const rows = this.#db
          .prepare(
            `SELECT m.id, m.role, m.speaker, m.text, m.ts
             FROM messages_fts f
             JOIN messages m ON m.id = f.rowid
             WHERE messages_fts MATCH ?
               AND m.persona_id = ?
               AND m.scope = ?
               ${exclusion}
             ORDER BY bm25(messages_fts), m.ts DESC
             LIMIT ?`,
          )
          .all(phrase, ...params) as MessageRow[];
        if (rows.length > 0) return rows.map(toSnippet);
      } catch {
        // Fall through to LIKE for punctuation-heavy or tokenizer edge cases.
      }
    }

    const pattern = `%${escapeLike(query)}%`;
    const rows = this.#db
      .prepare(
        `SELECT m.id, m.role, m.speaker, m.text, m.ts
         FROM messages m
         WHERE m.persona_id = ?
           AND m.scope = ?
           ${exclusion}
           AND m.text LIKE ? ESCAPE '\\'
         ORDER BY m.ts DESC
         LIMIT ?`,
      )
      .all(...params.slice(0, -1), pattern, limit) as MessageRow[];
    return rows.map(toSnippet);
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

  forget(input: { personaId: string; scope: string }): number {
    const ids = this.#db
      .prepare("SELECT id FROM messages WHERE persona_id = ? AND scope = ?")
      .all(input.personaId, input.scope) as Array<{ id: number }>;
    if (ids.length === 0) return 0;
    const removeFts = this.#db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
    const removeRow = this.#db.prepare("DELETE FROM messages WHERE id = ?");
    const transaction = this.#db.transaction(() => {
      for (const { id } of ids) {
        removeFts.run(id);
        removeRow.run(id);
      }
    });
    transaction();
    return ids.length;
  }

  close(): void {
    this.#db.close();
  }
}

function toSnippet(row: MessageRow): MemorySnippet {
  return { id: row.id, role: row.role, speaker: row.speaker, text: row.text, ts: row.ts };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
