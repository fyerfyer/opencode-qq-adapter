import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
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
  {
    version: 2,
    sql: `
      ALTER TABLE conversations ADD COLUMN actor_qq INTEGER;
      ALTER TABLE runs ADD COLUMN actor_qq INTEGER;

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL,
        run_id TEXT,
        chat_key TEXT NOT NULL,
        actor_qq INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        permission_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        message TEXT,
        status TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        replied_at INTEGER,
        replied_by INTEGER,
        decision TEXT,
        qq_message_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS approvals_session_permission
        ON approvals(session_id, permission_id);
      CREATE INDEX IF NOT EXISTS approvals_chat_status ON approvals(chat_key, status, requested_at DESC);
      CREATE INDEX IF NOT EXISTS approvals_session_status ON approvals(session_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS approvals_chat_short_id
        ON approvals(chat_key, short_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor_qq INTEGER,
        chat_key TEXT,
        project_id TEXT,
        workspace_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts DESC);
      CREATE INDEX IF NOT EXISTS audit_log_actor_ts ON audit_log(actor_qq, ts DESC);

      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        actor_qq INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        prompts INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, actor_qq, project_id)
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor_qq INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_events_lookup ON usage_events(actor_qq, kind, ts);
      CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE conversations ADD COLUMN workspace_id TEXT;
      ALTER TABLE runs ADD COLUMN workspace_id TEXT;

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        branch TEXT,
        owner_chat_key TEXT,
        status TEXT NOT NULL,
        locked_by_run_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS workspaces_project_status ON workspaces(project_id, status);
      CREATE INDEX IF NOT EXISTS workspaces_lease ON workspaces(lease_expires_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS admin_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expires ON admin_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions(username);
    `,
  },
];

/** Apply pending migrations in a single transaction per version. */
export function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );
  const apply = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      version,
      Date.now(),
    );
  });
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) {
      apply(migration.version, migration.sql);
    }
  }
}
