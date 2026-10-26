import Database from "better-sqlite3";

export interface BindingRecord {
  chatKey: string;
  namespace: string;
  previousProjectId: string | null;
  enabled: boolean;
  updatedAt: number;
}

interface BindingRow {
  chatKey: string;
  namespace: string;
  previousProjectId: string | null;
  enabled: number;
  updatedAt: number;
}

/**
 * Roleplay-only chat -> persona binding. Kept separate from the generic
 * transcript store so the memory package stays domain-agnostic.
 */
export class BindingStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        chat_key TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        previous_project_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
    this.#migrate();
  }

  #migrate(): void {
    const columns = this.#db.prepare("PRAGMA table_info(bindings)").all() as Array<{
      name: string;
    }>;
    if (
      columns.some((column) => column.name === "persona_id") &&
      !columns.some((column) => column.name === "namespace")
    ) {
      this.#db.exec("ALTER TABLE bindings RENAME COLUMN persona_id TO namespace");
    }
  }

  get(chatKey: string): BindingRecord | null {
    const row = this.#db
      .prepare(
        "SELECT chat_key AS chatKey, namespace, previous_project_id AS previousProjectId, enabled, updated_at AS updatedAt FROM bindings WHERE chat_key = ?",
      )
      .get(chatKey) as BindingRow | undefined;
    return row === undefined ? null : toBinding(row);
  }

  list(): BindingRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT chat_key AS chatKey, namespace, previous_project_id AS previousProjectId, enabled, updated_at AS updatedAt FROM bindings ORDER BY updated_at DESC",
      )
      .all() as BindingRow[];
    return rows.map(toBinding);
  }

  setEnabled(chatKey: string, enabled: boolean, now = Date.now()): BindingRecord | null {
    const existing = this.get(chatKey);
    if (existing === null) return null;
    this.set({ ...existing, enabled, updatedAt: now });
    return { ...existing, enabled, updatedAt: now };
  }

  remove(chatKey: string): boolean {
    const result = this.#db.prepare("DELETE FROM bindings WHERE chat_key = ?").run(chatKey);
    return result.changes > 0;
  }

  set(input: BindingRecord): void {
    this.#db
      .prepare(
        `INSERT INTO bindings (chat_key, namespace, previous_project_id, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_key) DO UPDATE SET
           namespace = excluded.namespace,
           previous_project_id = excluded.previous_project_id,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.chatKey,
        input.namespace,
        input.previousProjectId,
        input.enabled ? 1 : 0,
        input.updatedAt,
      );
  }

  close(): void {
    this.#db.close();
  }
}

function toBinding(row: BindingRow): BindingRecord {
  return {
    chatKey: row.chatKey,
    namespace: row.namespace,
    previousProjectId: row.previousProjectId,
    enabled: row.enabled === 1,
    updatedAt: row.updatedAt,
  };
}
