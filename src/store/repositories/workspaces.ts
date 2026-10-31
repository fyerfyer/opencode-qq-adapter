import type Database from "better-sqlite3";
import type { WorkspaceRecord } from "../../domain/workspace.js";
import type { StorePort } from "../../ports/store.js";
import { mapWorkspace, type WorkspaceRow } from "../rows.js";

export function createWorkspacesRepository(db: Database.Database): StorePort["workspaces"] {
  return {
    ensure: (record: WorkspaceRecord): void => {
      db.prepare(
        `INSERT INTO workspaces
           (id, project_id, kind, path, branch, owner_chat_key, status, locked_by_run_id,
            lease_expires_at, created_at, last_used_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           kind = excluded.kind,
           path = excluded.path,
           last_used_at = excluded.last_used_at`,
      ).run(
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
        null,
      );
    },
    get: (id: string): WorkspaceRecord | null => {
      const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
        | WorkspaceRow
        | undefined;
      return row ? mapWorkspace(row) : null;
    },
    getByProject: (projectId: string): WorkspaceRecord | null => {
      const row = db
        .prepare(
          "SELECT * FROM workspaces WHERE project_id = ? AND kind = 'shared' ORDER BY last_used_at DESC LIMIT 1",
        )
        .get(projectId) as WorkspaceRow | undefined;
      return row ? mapWorkspace(row) : null;
    },
    list: (projectId?: string): WorkspaceRecord[] => {
      const rows =
        projectId === undefined
          ? (db
              .prepare("SELECT * FROM workspaces ORDER BY last_used_at DESC")
              .all() as WorkspaceRow[])
          : (db
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
      const result = db
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
      const result = db
        .prepare(
          `UPDATE workspaces SET lease_expires_at = ?
           WHERE id = ? AND status = 'locked' AND locked_by_run_id = ?`,
        )
        .run(expiresAt, id, runId);
      return result.changes > 0;
    },
    unlock: (id: string, runId: string | null, now: number): void => {
      db.prepare(
        `UPDATE workspaces
         SET status = 'idle', locked_by_run_id = NULL, lease_expires_at = NULL, last_used_at = ?
         WHERE id = ? AND (? IS NULL OR locked_by_run_id = ?)`,
      ).run(now, id, runId, runId);
    },
    recoverLocks: (now: number): number => {
      const result = db
        .prepare(
          `UPDATE workspaces
           SET status = 'idle', locked_by_run_id = NULL, lease_expires_at = NULL, last_used_at = ?
           WHERE status = 'locked'`,
        )
        .run(now);
      return result.changes;
    },
    releaseExpired: (now: number): number => {
      const result = db
        .prepare(
          `UPDATE workspaces
           SET status = 'idle', locked_by_run_id = NULL, lease_expires_at = NULL, last_used_at = ?
           WHERE status = 'locked' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
        )
        .run(now, now);
      return result.changes;
    },
  };
}
