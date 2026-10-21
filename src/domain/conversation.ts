export interface ConversationRecord {
  chatKey: string;
  projectId: string;
  sessionId: string | null;
  /** QQ user that most recently used this conversation. */
  actorQq: number | null;
  agent: string | null;
  model: string | null;
  createdAt: number;
  lastActiveAt: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "rejected";

export interface RunRecord {
  id: string;
  chatKey: string;
  projectId: string;
  sessionId: string | null;
  /** QQ user that submitted this run. */
  actorQq: number | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  stopReason: string | null;
  error: string | null;
  usageJson: string | null;
}

export interface RunFinish {
  status: RunStatus;
  finishedAt: number;
  stopReason?: string;
  error?: string;
  usageJson?: string;
}
