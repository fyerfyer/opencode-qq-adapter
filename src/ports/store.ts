import type { ApprovalRecord, ApprovalUpdate } from "../domain/approval.js";
import type { AuditEntry, AuditRecord, DailyUsage } from "../domain/audit.js";
import type {
  ConversationRecord,
  RunFinish,
  RunRecord,
  RunStatus,
} from "../domain/conversation.js";
import type { WorkspaceKind, WorkspaceRecord, WorkspaceStatus } from "../domain/workspace.js";

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface StorePort {
  conversations: {
    get(chatKey: string): ConversationRecord | null;
    findBySession(sessionId: string): ConversationRecord | null;
    upsert(record: ConversationRecord): void;
    setSession(
      chatKey: string,
      sessionId: string | null,
      agent: string | null,
      model: string | null,
    ): void;
    setWorkspace(chatKey: string, workspaceId: string | null): void;
    list(): ConversationRecord[];
  };
  workspaces: {
    ensure(record: WorkspaceRecord): void;
    get(id: string): WorkspaceRecord | null;
    getByProject(projectId: string, kind?: WorkspaceKind): WorkspaceRecord | null;
    list(projectId?: string): WorkspaceRecord[];
    /** Atomically lock unless another live run holds the workspace. */
    tryLock(id: string, runId: string, chatKey: string, now: number, expiresAt: number): boolean;
    renew(id: string, runId: string, expiresAt: number): boolean;
    unlock(id: string, runId: string | null, now: number): void;
    setStatus(id: string, status: WorkspaceStatus, now: number): void;
    /** Release every lock; used once at startup because one bridge owns the DB. */
    recoverLocks(now: number): number;
    releaseExpired(now: number): number;
  };
  runs: {
    create(record: RunRecord): void;
    setStatus(id: string, status: RunStatus): void;
    setSession(id: string, sessionId: string): void;
    setWorkspace(id: string, workspaceId: string): void;
    finish(id: string, finish: RunFinish): void;
    get(id: string): RunRecord | null;
    activeForChat(chatKey: string): RunRecord | null;
    activeForSession(sessionId: string): RunRecord | null;
    listRecent(chatKey: string, limit: number): RunRecord[];
    listByStatus(status: RunStatus): RunRecord[];
    /** Mark runs left active by a previous process as interrupted. Returns affected rows. */
    recoverActive(finishedAt: number): number;
  };
  approvals: {
    create(record: ApprovalRecord): void;
    get(id: string): ApprovalRecord | null;
    getByPermission(sessionId: string, permissionId: string): ApprovalRecord | null;
    findPendingByChat(chatKey: string): ApprovalRecord[];
    findPendingBySession(sessionId: string): ApprovalRecord[];
    findPendingByMessage(chatKey: string, qqMessageId: string): ApprovalRecord | null;
    listPending(chatKey?: string): ApprovalRecord[];
    listRecent(chatKey: string, limit: number): ApprovalRecord[];
    update(id: string, update: ApprovalUpdate): void;
  };
  audit: {
    record(entry: AuditEntry): void;
    listRecent(limit: number): AuditRecord[];
    prune(before: number): number;
  };
  usage: {
    recordPrompt(day: string, actorQq: number, projectId: string): void;
    addRunUsage(day: string, actorQq: number, projectId: string, usage: UsageDelta): void;
    getDaily(day: string, actorQq: number, projectId: string): DailyUsage;
    getActorDaily(day: string, actorQq: number): DailyUsage;
    getProjectDaily(day: string, projectId: string): DailyUsage;
    recordEvent(ts: number, actorQq: number, projectId: string, kind: string): void;
    countEvents(actorQq: number, kind: string, since: number): number;
    pruneEvents(before: number): number;
  };
  seenMessages: {
    /** Returns true when the message has not been seen before. */
    mark(messageId: string, now: number): boolean;
    prune(before: number): number;
  };
  ping(): boolean;
  close(): void;
}
