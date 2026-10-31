import type Database from "better-sqlite3";
import type { StorePort } from "../../ports/store.js";

export function createSeenMessagesRepository(db: Database.Database): StorePort["seenMessages"] {
  return {
    mark: (messageId: string, now: number): boolean => {
      const result = db
        .prepare("INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?, ?)")
        .run(messageId, now);
      return result.changes > 0;
    },
    prune: (before: number): number => {
      const result = db.prepare("DELETE FROM seen_messages WHERE seen_at < ?").run(before);
      return result.changes;
    },
  };
}
