import type Database from "better-sqlite3";
import type { ConversationRecord } from "../../domain/conversation.js";
import type { StorePort } from "../../ports/store.js";
import { type ConversationRow, mapConversation } from "../rows.js";

export function createConversationsRepository(db: Database.Database): StorePort["conversations"] {
  return {
    get: (chatKey: string): ConversationRecord | null => {
      const row = db.prepare("SELECT * FROM conversations WHERE chat_key = ?").get(chatKey) as
        | ConversationRow
        | undefined;
      return row ? mapConversation(row) : null;
    },
    findBySession: (sessionId: string): ConversationRecord | null => {
      const row = db
        .prepare("SELECT * FROM conversations WHERE session_id = ? LIMIT 1")
        .get(sessionId) as ConversationRow | undefined;
      return row ? mapConversation(row) : null;
    },
    upsert: (record: ConversationRecord): void => {
      db.prepare(
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
      ).run(
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
      db.prepare(
        `UPDATE conversations
         SET session_id = ?, agent = ?, model = ?, last_active_at = ?
         WHERE chat_key = ?`,
      ).run(sessionId, agent, model, Date.now(), chatKey);
    },
    setWorkspace: (chatKey: string, workspaceId: string | null): void => {
      db.prepare(
        "UPDATE conversations SET workspace_id = ?, last_active_at = ? WHERE chat_key = ?",
      ).run(workspaceId, Date.now(), chatKey);
    },
    list: (): ConversationRecord[] => {
      const rows = db
        .prepare("SELECT * FROM conversations ORDER BY last_active_at DESC")
        .all() as ConversationRow[];
      return rows.map(mapConversation);
    },
  };
}
