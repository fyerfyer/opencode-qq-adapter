export type WorkspaceKind = "shared" | "per_user" | "worktree" | "ephemeral";

export type WorkspaceStatus = "idle" | "locked" | "dirty" | "cleanup_pending" | "removed";

export interface WorkspaceRecord {
  id: string;
  projectId: string;
  kind: WorkspaceKind;
  path: string;
  branch: string | null;
  ownerChatKey: string | null;
  status: WorkspaceStatus;
  lockedByRunId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  lastUsedAt: number;
  metadata: Record<string, unknown> | null;
}

export interface WorkspaceLease {
  id: string;
  projectId: string;
  kind: WorkspaceKind;
  path: string;
  branch: string | null;
  ownerChatKey: string;
  runId: string;
  leaseExpiresAt: number;
}

export interface WorkspaceDiffFile {
  file: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch?: string;
}
