import type Database from "better-sqlite3";
import type { RunFinish, RunRecord, RunStatus } from "../../domain/conversation.js";
import type { StorePort } from "../../ports/store.js";
import { mapRun, type RunRow } from "../rows.js";

export function createRunsRepository(db: Database.Database): StorePort["runs"] {
  return {
    create: (record: RunRecord): void => {
      db.prepare(
        `INSERT INTO runs
           (id, chat_key, project_id, workspace_id, session_id, actor_qq, status,
            started_at, finished_at, stop_reason, error, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      db.prepare(
        `UPDATE runs
         SET status = ?, finished_at = ?, stop_reason = ?, error = ?, usage_json = ?
         WHERE id = ?`,
      ).run(
        finish.status,
        finish.finishedAt,
        finish.stopReason ?? null,
        finish.error ?? null,
        finish.usageJson ?? null,
        id,
      );
    },
    setSession: (id: string, sessionId: string): void => {
      db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(sessionId, id);
    },
    setWorkspace: (id: string, workspaceId: string): void => {
      db.prepare("UPDATE runs SET workspace_id = ? WHERE id = ?").run(workspaceId, id);
    },
    setStatus: (id: string, status: RunStatus): void => {
      db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
    },
    get: (id: string): RunRecord | null => {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    activeForChat: (chatKey: string): RunRecord | null => {
      const row = db
        .prepare(
          `SELECT * FROM runs
           WHERE chat_key = ? AND status IN ('running', 'waiting_permission', 'queued')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(chatKey) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    activeForSession: (sessionId: string): RunRecord | null => {
      const row = db
        .prepare(
          `SELECT * FROM runs
           WHERE session_id = ? AND status IN ('running', 'waiting_permission')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(sessionId) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    listRecent: (chatKey: string, limit: number): RunRecord[] => {
      const rows = db
        .prepare("SELECT * FROM runs WHERE chat_key = ? ORDER BY started_at DESC LIMIT ?")
        .all(chatKey, limit) as RunRow[];
      return rows.map(mapRun);
    },
    listRecentAll: (limit: number): RunRecord[] => {
      const rows = db
        .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
        .all(limit) as RunRow[];
      return rows.map(mapRun);
    },
    listByStatus: (status: RunStatus): RunRecord[] => {
      const rows = db
        .prepare("SELECT * FROM runs WHERE status = ? ORDER BY started_at ASC")
        .all(status) as RunRow[];
      return rows.map(mapRun);
    },
    recoverActive: (finishedAt: number): number => {
      const result = db
        .prepare(
          `UPDATE runs
           SET status = 'interrupted', finished_at = ?, stop_reason = 'bridge_restart'
           WHERE status IN ('queued', 'running', 'waiting_permission')`,
        )
        .run(finishedAt);
      return result.changes;
    },
  };
}
