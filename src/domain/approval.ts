import type { ApprovalDecision } from "./permission.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface ApprovalRecord {
  id: string;
  /** Short human-friendly identifier shown in QQ (unique among pending items). */
  shortId: string;
  runId: string | null;
  chatKey: string;
  actorQq: number;
  projectId: string;
  sessionId: string;
  permissionId: string;
  action: string;
  resources: string[];
  message: string | null;
  status: ApprovalStatus;
  requestedAt: number;
  expiresAt: number;
  repliedAt: number | null;
  repliedBy: number | null;
  decision: ApprovalDecision | null;
  /** QQ message ID of the prompt, enabling quote-based approval. */
  qqMessageId: string | null;
}

export interface ApprovalUpdate {
  status?: ApprovalStatus;
  repliedAt?: number | null;
  repliedBy?: number | null;
  decision?: ApprovalDecision | null;
  qqMessageId?: string | null;
}
