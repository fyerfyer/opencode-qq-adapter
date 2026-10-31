import type Database from "better-sqlite3";
import type { AuditEntry, AuditRecord } from "../../domain/audit.js";
import type { StorePort } from "../../ports/store.js";
import { type AuditRow, mapAudit, safeJson } from "../rows.js";

export function createAuditRepository(db: Database.Database): StorePort["audit"] {
  return {
    record: (entry: AuditEntry): void => {
      db.prepare(
        `INSERT INTO audit_log (ts, actor_qq, chat_key, project_id, workspace_id, action, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      const rows = db
        .prepare("SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?")
        .all(limit) as AuditRow[];
      return rows.map(mapAudit);
    },
    prune: (before: number): number => {
      const result = db.prepare("DELETE FROM audit_log WHERE ts < ?").run(before);
      return result.changes;
    },
  };
}
