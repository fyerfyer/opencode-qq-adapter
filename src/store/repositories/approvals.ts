import type Database from "better-sqlite3";
import type { ApprovalRecord, ApprovalUpdate } from "../../domain/approval.js";
import type { StorePort } from "../../ports/store.js";
import { type ApprovalRow, mapApproval } from "../rows.js";

export function createApprovalsRepository(db: Database.Database): StorePort["approvals"] {
  return {
    create: (record: ApprovalRecord): void => {
      db.prepare(
        `INSERT INTO approvals
           (id, short_id, run_id, chat_key, actor_qq, project_id, session_id, permission_id,
            action, resources_json, message, status, requested_at, expires_at, replied_at,
            replied_by, decision, qq_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
        | ApprovalRow
        | undefined;
      return row ? mapApproval(row) : null;
    },
    getByPermission: (sessionId: string, permissionId: string): ApprovalRecord | null => {
      const row = db
        .prepare("SELECT * FROM approvals WHERE session_id = ? AND permission_id = ?")
        .get(sessionId, permissionId) as ApprovalRow | undefined;
      return row ? mapApproval(row) : null;
    },
    findPendingByChat: (chatKey: string): ApprovalRecord[] => {
      const rows = db
        .prepare(
          "SELECT * FROM approvals WHERE chat_key = ? AND status = 'pending' ORDER BY requested_at ASC",
        )
        .all(chatKey) as ApprovalRow[];
      return rows.map(mapApproval);
    },
    findPendingBySession: (sessionId: string): ApprovalRecord[] => {
      const rows = db
        .prepare(
          "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY requested_at ASC",
        )
        .all(sessionId) as ApprovalRow[];
      return rows.map(mapApproval);
    },
    findPendingByMessage: (chatKey: string, qqMessageId: string): ApprovalRecord | null => {
      const row = db
        .prepare(
          "SELECT * FROM approvals WHERE chat_key = ? AND qq_message_id = ? AND status = 'pending' LIMIT 1",
        )
        .get(chatKey, qqMessageId) as ApprovalRow | undefined;
      return row ? mapApproval(row) : null;
    },
    listPending: (chatKey?: string): ApprovalRecord[] => {
      const rows =
        chatKey === undefined
          ? (db
              .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC")
              .all() as ApprovalRow[])
          : (db
              .prepare(
                "SELECT * FROM approvals WHERE status = 'pending' AND chat_key = ? ORDER BY requested_at ASC",
              )
              .all(chatKey) as ApprovalRow[]);
      return rows.map(mapApproval);
    },
    listRecent: (chatKey: string, limit: number): ApprovalRecord[] => {
      const rows = db
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
      db.prepare(`UPDATE approvals SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    },
  };
}
