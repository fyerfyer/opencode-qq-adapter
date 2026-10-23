import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AdminSessionInput, AdminSessionRecord, AdminUserRecord } from "../domain/admin.js";
import type { ApprovalRecord, ApprovalStatus, ApprovalUpdate } from "../domain/approval.js";
import type { AuditEntry, AuditRecord, DailyUsage } from "../domain/audit.js";
import type {
  ConversationRecord,
  RunFinish,
  RunRecord,
  RunStatus,
} from "../domain/conversation.js";
import type { ApprovalDecision } from "../domain/permission.js";
import type { WorkspaceKind, WorkspaceRecord, WorkspaceStatus } from "../domain/workspace.js";
import type { StorePort, UsageDelta } from "../ports/store.js";

interface ConversationRow {
  chat_key: string;
  project_id: string;
  workspace_id: string | null;
  session_id: string | null;
  actor_qq: number | null;
  agent: string | null;
  model: string | null;
  created_at: number;
  last_active_at: number;
}

interface RunRow {
  id: string;
  chat_key: string;
  project_id: string;
  workspace_id: string | null;
  session_id: string | null;
  actor_qq: number | null;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  stop_reason: string | null;
  error: string | null;
  usage_json: string | null;
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  kind: WorkspaceKind;
  path: string;
  branch: string | null;
  owner_chat_key: string | null;
  status: WorkspaceStatus;
  locked_by_run_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  last_used_at: number;
  metadata_json: string | null;
}

interface ApprovalRow {
  id: string;
  short_id: string;
  run_id: string | null;
  chat_key: string;
  actor_qq: number;
  project_id: string;
  session_id: string;
  permission_id: string;
  action: string;
  resources_json: string;
  message: string | null;
  status: ApprovalStatus;
  requested_at: number;
  expires_at: number;
  replied_at: number | null;
  replied_by: number | null;
  decision: ApprovalDecision | null;
  qq_message_id: string | null;
}

interface AuditRow {
  id: number;
  ts: number;
  actor_qq: number | null;
  chat_key: string | null;
  project_id: string | null;
  workspace_id: string | null;
  action: string;
  detail_json: string;
}

interface UsageRow {
  day: string;
  actor_qq: number;
  project_id: string;
  prompts: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface AdminUserRow {
  username: string;
  password_hash: string;
  must_change_password: number;
  created_at: number;
  updated_at: number;
}

interface AdminSessionRow {
  token_hash: string;
  username: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
  ip: string | null;
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

export class SqliteStore implements StorePort {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    try {
      this.#db = new Database(path);
    } catch (error) {
      if (isNativeBindingError(error)) {
        throw new Error(
          [
            "SQLite 原生模块 better-sqlite3 没有正确安装（找不到 better_sqlite3.node）。",
            "这通常发生在 npx 缓存不完整，或安装时跳过了 install script。",
            "",
            "修复方式：",
            "  npm cache clean --force",
            "  npm install -g opencode-qq-adapter",
            "",
            "如果仍然失败，请先安装构建工具，然后运行：",
            "  npm rebuild better-sqlite3 --build-from-source",
          ].join("\n"),
          { cause: error },
        );
      }
      throw error;
    }
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
    findBySession: (sessionId: string): ConversationRecord | null => {
      const row = this.#db
        .prepare("SELECT * FROM conversations WHERE session_id = ? LIMIT 1")
        .get(sessionId) as ConversationRow | undefined;
      return row ? mapConversation(row) : null;
    },
    upsert: (record: ConversationRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO conversations
             (chat_key, project_id, workspace_id, session_id, actor_qq, agent, model,
              created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_key) DO UPDATE SET
             project_id = excluded.project_id,
             workspace_id = excluded.workspace_id,
             session_id = excluded.session_id,
             actor_qq = excluded.actor_qq,
             agent = excluded.agent,
             model = excluded.model,
             last_active_at = excluded.last_active_at`,
        )
        .run(
          record.chatKey,
          record.projectId,
          record.workspaceId,
          record.sessionId,
          record.actorQq,
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
    setWorkspace: (chatKey: string, workspaceId: string | null): void => {
      this.#db
        .prepare("UPDATE conversations SET workspace_id = ?, last_active_at = ? WHERE chat_key = ?")
        .run(workspaceId, Date.now(), chatKey);
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
             (id, chat_key, project_id, workspace_id, session_id, actor_qq, status,
              started_at, finished_at, stop_reason, error, usage_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.chatKey,
          record.projectId,
          record.workspaceId,
          record.sessionId,
          record.actorQq,
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
    setWorkspace: (id: string, workspaceId: string): void => {
      this.#db.prepare("UPDATE runs SET workspace_id = ? WHERE id = ?").run(workspaceId, id);
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
    activeForSession: (sessionId: string): RunRecord | null => {
      const row = this.#db
        .prepare(
          `SELECT * FROM runs
           WHERE session_id = ? AND status IN ('running', 'waiting_permission')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(sessionId) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    listRecent: (chatKey: string, limit: number): RunRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM runs WHERE chat_key = ? ORDER BY started_at DESC LIMIT ?")
        .all(chatKey, limit) as RunRow[];
      return rows.map(mapRun);
    },
    listRecentAll: (limit: number): RunRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
        .all(limit) as RunRow[];
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

  approvals = {
    create: (record: ApprovalRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO approvals
             (id, short_id, run_id, chat_key, actor_qq, project_id, session_id, permission_id,
              action, resources_json, message, status, requested_at, expires_at, replied_at,
              replied_by, decision, qq_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.shortId,
          record.runId,
          record.chatKey,
          record.actorQq,
          record.projectId,
          record.sessionId,
          record.permissionId,
          record.action,
          JSON.stringify(record.resources),
          record.message,
          record.status,
          record.requestedAt,
          record.expiresAt,
          record.repliedAt,
          record.repliedBy,
          record.decision,
          record.qqMessageId,
        );
    },
    get: (id: string): ApprovalRecord | null => {
      const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
        | ApprovalRow
        | undefined;
      return row ? mapApproval(row) : null;
    },
    getByPermission: (sessionId: string, permissionId: string): ApprovalRecord | null => {
      const row = this.#db
        .prepare("SELECT * FROM approvals WHERE session_id = ? AND permission_id = ?")
        .get(sessionId, permissionId) as ApprovalRow | undefined;
      return row ? mapApproval(row) : null;
    },
    findPendingByChat: (chatKey: string): ApprovalRecord[] => {
      const rows = this.#db
        .prepare(
          "SELECT * FROM approvals WHERE chat_key = ? AND status = 'pending' ORDER BY requested_at ASC",
        )
        .all(chatKey) as ApprovalRow[];
      return rows.map(mapApproval);
    },
    findPendingBySession: (sessionId: string): ApprovalRecord[] => {
      const rows = this.#db
        .prepare(
          "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY requested_at ASC",
        )
        .all(sessionId) as ApprovalRow[];
      return rows.map(mapApproval);
    },
    findPendingByMessage: (chatKey: string, qqMessageId: string): ApprovalRecord | null => {
      const row = this.#db
        .prepare(
          "SELECT * FROM approvals WHERE chat_key = ? AND qq_message_id = ? AND status = 'pending' LIMIT 1",
        )
        .get(chatKey, qqMessageId) as ApprovalRow | undefined;
      return row ? mapApproval(row) : null;
    },
    listPending: (chatKey?: string): ApprovalRecord[] => {
      const rows =
        chatKey === undefined
          ? (this.#db
              .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC")
              .all() as ApprovalRow[])
          : (this.#db
              .prepare(
                "SELECT * FROM approvals WHERE status = 'pending' AND chat_key = ? ORDER BY requested_at ASC",
              )
              .all(chatKey) as ApprovalRow[]);
      return rows.map(mapApproval);
    },
    listRecent: (chatKey: string, limit: number): ApprovalRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM approvals WHERE chat_key = ? ORDER BY requested_at DESC LIMIT ?")
        .all(chatKey, limit) as ApprovalRow[];
      return rows.map(mapApproval);
    },
    update: (id: string, update: ApprovalUpdate): void => {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (update.status !== undefined) {
        assignments.push("status = ?");
        values.push(update.status);
      }
      if (update.repliedAt !== undefined) {
        assignments.push("replied_at = ?");
        values.push(update.repliedAt);
      }
      if (update.repliedBy !== undefined) {
        assignments.push("replied_by = ?");
        values.push(update.repliedBy);
      }
      if (update.decision !== undefined) {
        assignments.push("decision = ?");
        values.push(update.decision);
      }
      if (update.qqMessageId !== undefined) {
        assignments.push("qq_message_id = ?");
        values.push(update.qqMessageId);
      }
      if (assignments.length === 0) return;
      values.push(id);
      this.#db
        .prepare(`UPDATE approvals SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values);
    },
  };

  workspaces = {
    ensure: (record: WorkspaceRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO workspaces
             (id, project_id, kind, path, branch, owner_chat_key, status, locked_by_run_id,
              lease_expires_at, created_at, last_used_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             kind = excluded.kind,
             path = excluded.path,
             last_used_at = excluded.last_used_at`,
        )
        .run(
          record.id,
          record.projectId,
          record.kind,
          record.path,
          record.branch,
          record.ownerChatKey,
          record.status,
          record.lockedByRunId,
          record.leaseExpiresAt,
          record.createdAt,
          record.lastUsedAt,
          record.metadata === null ? null : safeJson(record.metadata),
        );
    },
    get: (id: string): WorkspaceRecord | null => {
      const row = this.#db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
        | WorkspaceRow
        | undefined;
      return row ? mapWorkspace(row) : null;
    },
    getByProject: (projectId: string, kind: WorkspaceKind = "shared"): WorkspaceRecord | null => {
      const row = this.#db
        .prepare(
          "SELECT * FROM workspaces WHERE project_id = ? AND kind = ? ORDER BY last_used_at DESC LIMIT 1",
        )
        .get(projectId, kind) as WorkspaceRow | undefined;
      return row ? mapWorkspace(row) : null;
    },
    list: (projectId?: string): WorkspaceRecord[] => {
      const rows =
        projectId === undefined
          ? (this.#db
              .prepare("SELECT * FROM workspaces ORDER BY last_used_at DESC")
              .all() as WorkspaceRow[])
          : (this.#db
              .prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY last_used_at DESC")
              .all(projectId) as WorkspaceRow[]);
      return rows.map(mapWorkspace);
    },
    tryLock: (
      id: string,
      runId: string,
      chatKey: string,
      now: number,
      expiresAt: number,
    ): boolean => {
      const result = this.#db
        .prepare(
          `UPDATE workspaces
           SET status = 'locked', locked_by_run_id = ?, owner_chat_key = ?,
               lease_expires_at = ?, last_used_at = ?
           WHERE id = ? AND (
             status != 'locked'
             OR locked_by_run_id = ?
             OR lease_expires_at IS NULL
             OR lease_expires_at < ?
           )`,
        )
        .run(runId, chatKey, expiresAt, now, id, runId, now);
      return result.changes > 0;
    },
    renew: (id: string, runId: string, expiresAt: number): boolean => {
      const result = this.#db
        .prepare(
          `UPDATE workspaces SET lease_expires_at = ?
           WHERE id = ? AND status = 'locked' AND locked_by_run_id = ?`,
        )
        .run(expiresAt, id, runId);
      return result.changes > 0;
    },
    unlock: (id: string, runId: string | null, now: number): void => {
      this.#db
        .prepare(
          `UPDATE workspaces
           SET status = 'idle', locked_by_run_id = NULL, lease_expires_at = NULL, last_used_at = ?
           WHERE id = ? AND (? IS NULL OR locked_by_run_id = ?)`,
        )
        .run(now, id, runId, runId);
    },
    setStatus: (id: string, status: WorkspaceStatus, now: number): void => {
      this.#db
        .prepare("UPDATE workspaces SET status = ?, last_used_at = ? WHERE id = ?")
        .run(status, now, id);
    },
    recoverLocks: (now: number): number => {
      const result = this.#db
        .prepare(
          `UPDATE workspaces
           SET status = 'idle', locked_by_run_id = NULL, lease_expires_at = NULL, last_used_at = ?
           WHERE status = 'locked'`,
        )
        .run(now);
      return result.changes;
    },
    releaseExpired: (now: number): number => {
      const result = this.#db
        .prepare(
          `UPDATE workspaces
           SET status = 'idle', locked_by_run_id = NULL, lease_expires_at = NULL, last_used_at = ?
           WHERE status = 'locked' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
        )
        .run(now, now);
      return result.changes;
    },
  };

  audit = {
    record: (entry: AuditEntry): void => {
      this.#db
        .prepare(
          `INSERT INTO audit_log (ts, actor_qq, chat_key, project_id, workspace_id, action, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.ts,
          entry.actorQq,
          entry.chatKey,
          entry.projectId,
          entry.workspaceId,
          entry.action,
          safeJson(entry.detail),
        );
    },
    listRecent: (limit: number): AuditRecord[] => {
      const rows = this.#db
        .prepare("SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?")
        .all(limit) as AuditRow[];
      return rows.map(mapAudit);
    },
    prune: (before: number): number => {
      const result = this.#db.prepare("DELETE FROM audit_log WHERE ts < ?").run(before);
      return result.changes;
    },
  };

  usage = {
    recordPrompt: (day: string, actorQq: number, projectId: string): void => {
      this.#db
        .prepare(
          `INSERT INTO usage_daily (day, actor_qq, project_id, prompts, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, 1, 0, 0, 0)
           ON CONFLICT(day, actor_qq, project_id) DO UPDATE SET prompts = prompts + 1`,
        )
        .run(day, actorQq, projectId);
    },
    addRunUsage: (day: string, actorQq: number, projectId: string, usage: UsageDelta): void => {
      this.#db
        .prepare(
          `INSERT INTO usage_daily (day, actor_qq, project_id, prompts, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(day, actor_qq, project_id) DO UPDATE SET
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             cost_usd = cost_usd + excluded.cost_usd`,
        )
        .run(day, actorQq, projectId, usage.inputTokens, usage.outputTokens, usage.costUsd);
    },
    getDaily: (day: string, actorQq: number, projectId: string): DailyUsage => {
      const row = this.#db
        .prepare("SELECT * FROM usage_daily WHERE day = ? AND actor_qq = ? AND project_id = ?")
        .get(day, actorQq, projectId) as UsageRow | undefined;
      return row ? mapUsage(row) : emptyUsage(day, actorQq, projectId);
    },
    getActorDaily: (day: string, actorQq: number): DailyUsage => {
      const row = this.#db
        .prepare(
          `SELECT ?, ?, '', COALESCE(SUM(prompts), 0) AS prompts,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM usage_daily WHERE day = ? AND actor_qq = ?`,
        )
        .get(day, actorQq, day, actorQq) as UsageRow;
      return mapUsage({ ...row, project_id: "" });
    },
    getProjectDaily: (day: string, projectId: string): DailyUsage => {
      const row = this.#db
        .prepare(
          `SELECT ?, NULL, ?, COALESCE(SUM(prompts), 0) AS prompts,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd
           FROM usage_daily WHERE day = ? AND project_id = ?`,
        )
        .get(day, projectId, day, projectId) as UsageRow;
      return mapUsage({ ...row, actor_qq: 0 });
    },
    listDaily: (day: string): DailyUsage[] => {
      const rows = this.#db
        .prepare("SELECT * FROM usage_daily WHERE day = ? ORDER BY cost_usd DESC, prompts DESC")
        .all(day) as UsageRow[];
      return rows.map(mapUsage);
    },
    recordEvent: (ts: number, actorQq: number, projectId: string, kind: string): void => {
      this.#db
        .prepare("INSERT INTO usage_events (ts, actor_qq, project_id, kind) VALUES (?, ?, ?, ?)")
        .run(ts, actorQq, projectId, kind);
    },
    countEvents: (actorQq: number, kind: string, since: number): number => {
      const row = this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_events WHERE actor_qq = ? AND kind = ? AND ts >= ?",
        )
        .get(actorQq, kind, since) as { count: number };
      return row.count;
    },
    pruneEvents: (before: number): number => {
      const result = this.#db.prepare("DELETE FROM usage_events WHERE ts < ?").run(before);
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

  admin = {
    getUser: (username: string): AdminUserRecord | null => {
      const row = this.#db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username) as
        | AdminUserRow
        | undefined;
      return row ? mapAdminUser(row) : null;
    },
    createUser: (record: AdminUserRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO admin_users
             (username, password_hash, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          record.username,
          record.passwordHash,
          record.mustChangePassword ? 1 : 0,
          record.createdAt,
          record.updatedAt,
        );
    },
    updatePassword: (
      username: string,
      passwordHash: string,
      mustChange: boolean,
      now: number,
    ): void => {
      this.#db
        .prepare(
          `UPDATE admin_users
           SET password_hash = ?, must_change_password = ?, updated_at = ?
           WHERE username = ?`,
        )
        .run(passwordHash, mustChange ? 1 : 0, now, username);
    },
    createSession: (record: AdminSessionInput): void => {
      this.#db
        .prepare(
          `INSERT INTO admin_sessions
             (token_hash, username, csrf_token, created_at, expires_at, last_seen_at, user_agent, ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.tokenHash,
          record.username,
          record.csrfToken,
          record.createdAt,
          record.expiresAt,
          record.createdAt,
          record.userAgent,
          record.ip,
        );
    },
    getSession: (tokenHash: string): AdminSessionRecord | null => {
      const row = this.#db
        .prepare("SELECT * FROM admin_sessions WHERE token_hash = ?")
        .get(tokenHash) as AdminSessionRow | undefined;
      return row ? mapAdminSession(row) : null;
    },
    touchSession: (tokenHash: string, lastSeenAt: number, expiresAt: number): void => {
      this.#db
        .prepare("UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
        .run(lastSeenAt, expiresAt, tokenHash);
    },
    deleteSession: (tokenHash: string): void => {
      this.#db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
    },
    deleteSessions: (username?: string): number => {
      const result =
        username === undefined
          ? this.#db.prepare("DELETE FROM admin_sessions").run()
          : this.#db.prepare("DELETE FROM admin_sessions WHERE username = ?").run(username);
      return result.changes;
    },
    pruneSessions: (now: number): number => {
      const result = this.#db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(now);
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
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    actorQq: row.actor_qq,
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
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    actorQq: row.actor_qq,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stopReason: row.stop_reason,
    error: row.error,
    usageJson: row.usage_json,
  };
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    path: row.path,
    branch: row.branch,
    ownerChatKey: row.owner_chat_key,
    status: row.status,
    lockedByRunId: row.locked_by_run_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    metadata:
      row.metadata_json === null ? null : (parseJson(row.metadata_json) as Record<string, unknown>),
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    shortId: row.short_id,
    runId: row.run_id,
    chatKey: row.chat_key,
    actorQq: row.actor_qq,
    projectId: row.project_id,
    sessionId: row.session_id,
    permissionId: row.permission_id,
    action: row.action,
    resources: parseStringArray(row.resources_json),
    message: row.message,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    repliedAt: row.replied_at,
    repliedBy: row.replied_by,
    decision: row.decision,
    qqMessageId: row.qq_message_id,
  };
}

function mapAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    ts: row.ts,
    actorQq: row.actor_qq,
    chatKey: row.chat_key,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    action: row.action,
    detail: parseJson(row.detail_json),
  };
}

function mapAdminUser(row: AdminUserRow): AdminUserRecord {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdminSession(row: AdminSessionRow): AdminSessionRecord {
  return {
    tokenHash: row.token_hash,
    username: row.username,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

function mapUsage(row: UsageRow): DailyUsage {
  return {
    day: row.day,
    actorQq: row.actor_qq === 0 ? null : row.actor_qq,
    projectId: row.project_id === "" ? null : row.project_id,
    prompts: row.prompts,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  };
}

function emptyUsage(day: string, actorQq: number | null, projectId: string | null): DailyUsage {
  return { day, actorQq, projectId, prompts: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: "unserializable detail" });
  }
}

function isNativeBindingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not locate the bindings file") ||
    message.includes("better_sqlite3.node") ||
    message.includes("Module did not self-register")
  );
}
