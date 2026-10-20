import type {
  ConversationRecord,
  RunFinish,
  RunRecord,
  RunStatus,
} from "../domain/conversation.js";

export interface StorePort {
  conversations: {
    get(chatKey: string): ConversationRecord | null;
    upsert(record: ConversationRecord): void;
    setSession(
      chatKey: string,
      sessionId: string | null,
      agent: string | null,
      model: string | null,
    ): void;
    list(): ConversationRecord[];
  };
  runs: {
    create(record: RunRecord): void;
    setStatus(id: string, status: RunStatus): void;
    setSession(id: string, sessionId: string): void;
    finish(id: string, finish: RunFinish): void;
    get(id: string): RunRecord | null;
    activeForChat(chatKey: string): RunRecord | null;
    listRecent(chatKey: string, limit: number): RunRecord[];
    listByStatus(status: RunStatus): RunRecord[];
    /** Mark runs left active by a previous process as interrupted. Returns affected rows. */
    recoverActive(finishedAt: number): number;
  };
  seenMessages: {
    /** Returns true when the message has not been seen before. */
    mark(messageId: string, now: number): boolean;
    prune(before: number): number;
  };
  ping(): boolean;
  close(): void;
}
