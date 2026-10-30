export type WorkspaceKind = "shared";

export type WorkspaceStatus = "idle" | "locked";

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
}

export interface WorkspaceLease {
  id: string;
  projectId: string;
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
