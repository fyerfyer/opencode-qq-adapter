import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ConversationRecord,
  RunFinish,
  RunRecord,
  RunStatus,
} from "../domain/conversation.js";
import type { StorePort } from "../ports/store.js";

interface ConversationRow {
  chat_key: string;
  project_id: string;
  session_id: string | null;
  agent: string | null;
  model: string | null;
  created_at: number;
  last_active_at: number;
}

interface RunRow {
  id: string;
  chat_key: string;
  project_id: string;
  session_id: string | null;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  stop_reason: string | null;
  error: string | null;
  usage_json: string | null;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        chat_key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        agent TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        stop_reason TEXT,
        error TEXT,
        usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_chat_started ON runs(chat_key, started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS seen_messages (
        message_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS seen_messages_seen_at ON seen_messages(seen_at);
    `,
  },
];

export class SqliteStore implements StorePort {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new Database(path);
    this.#db.pragma("busy_timeout = 5000");
    this.#db.pragma("foreign_keys = ON");
    if (path !== ":memory:") {
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = NORMAL");
    }
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set(
      this.#db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => (row as { version: number }).version),
    );
    const apply = this.#db.transaction((version: number, sql: string) => {
      this.#db.exec(sql);
      this.#db
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, Date.now());
    });
    for (const migration of MIGRATIONS) {
      if (!applied.has(migration.version)) {
        apply(migration.version, migration.sql);
      }
    }
  }

  conversations = {
    get: (chatKey: string): ConversationRecord | null => {
      const row = this.#db.prepare("SELECT * FROM conversations WHERE chat_key = ?").get(chatKey) as
        | ConversationRow
        | undefined;
      return row ? mapConversation(row) : null;
    },
    upsert: (record: ConversationRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO conversations
             (chat_key, project_id, session_id, agent, model, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_key) DO UPDATE SET
             project_id = excluded.project_id,
             session_id = excluded.session_id,
             agent = excluded.agent,
             model = excluded.model,
             last_active_at = excluded.last_active_at`,
        )
        .run(
          record.chatKey,
          record.projectId,
          record.sessionId,
          record.agent,
          record.model,
          record.createdAt,
          record.lastActiveAt,
        );
    },
    setSession: (
      chatKey: string,
      sessionId: string | null,
      agent: string | null,
      model: string | null,
    ): void => {
      this.#db
        .prepare(
          `UPDATE conversations
           SET session_id = ?, agent = ?, model = ?, last_active_at = ?
           WHERE chat_key = ?`,
        )
        .run(sessionId, agent, model, Date.now(), chatKey);
    },
    list: (): ConversationRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM conversations ORDER BY last_active_at DESC")
        .all() as ConversationRow[];
      return rows.map(mapConversation);
    },
  };

  runs = {
    create: (record: RunRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO runs
             (id, chat_key, project_id, session_id, status, started_at, finished_at, stop_reason, error, usage_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.chatKey,
          record.projectId,
          record.sessionId,
          record.status,
          record.startedAt,
          record.finishedAt,
          record.stopReason,
          record.error,
          record.usageJson,
        );
    },
    finish: (id: string, finish: RunFinish): void => {
      this.#db
        .prepare(
          `UPDATE runs
           SET status = ?, finished_at = ?, stop_reason = ?, error = ?, usage_json = ?
           WHERE id = ?`,
        )
        .run(
          finish.status,
          finish.finishedAt,
          finish.stopReason ?? null,
          finish.error ?? null,
          finish.usageJson ?? null,
          id,
        );
    },
    setSession: (id: string, sessionId: string): void => {
      this.#db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(sessionId, id);
    },
    setStatus: (id: string, status: RunStatus): void => {
      this.#db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
    },
    get: (id: string): RunRecord | null => {
      const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    activeForChat: (chatKey: string): RunRecord | null => {
      const row = this.#db
        .prepare(
          `SELECT * FROM runs
           WHERE chat_key = ? AND status IN ('running', 'waiting_permission', 'queued')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(chatKey) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    listRecent: (chatKey: string, limit: number): RunRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM runs WHERE chat_key = ? ORDER BY started_at DESC LIMIT ?")
        .all(chatKey, limit) as RunRow[];
      return rows.map(mapRun);
    },
    listByStatus: (status: RunStatus): RunRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM runs WHERE status = ? ORDER BY started_at ASC")
        .all(status) as RunRow[];
      return rows.map(mapRun);
    },
    recoverActive: (finishedAt: number): number => {
      const result = this.#db
        .prepare(
          `UPDATE runs
           SET status = 'interrupted', finished_at = ?, stop_reason = 'bridge_restart'
           WHERE status IN ('queued', 'running', 'waiting_permission')`,
        )
        .run(finishedAt);
      return result.changes;
    },
  };

  seenMessages = {
    mark: (messageId: string, now: number): boolean => {
      const result = this.#db
        .prepare("INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?, ?)")
        .run(messageId, now);
      return result.changes > 0;
    },
    prune: (before: number): number => {
      const result = this.#db.prepare("DELETE FROM seen_messages WHERE seen_at < ?").run(before);
      return result.changes;
    },
  };

  ping(): boolean {
    try {
      this.#db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.#db.close();
  }
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    chatKey: row.chat_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    agent: row.agent,
    model: row.model,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    chatKey: row.chat_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stopReason: row.stop_reason,
    error: row.error,
    usageJson: row.usage_json,
  };
}
