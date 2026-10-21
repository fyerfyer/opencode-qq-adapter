export interface AuditEntry {
  ts: number;
  actorQq: number | null;
  chatKey: string | null;
  projectId: string | null;
  workspaceId: string | null;
  action: string;
  detail: unknown;
}

export interface AuditRecord extends AuditEntry {
  id: number;
}

export interface DailyUsage {
  day: string;
  actorQq: number | null;
  projectId: string | null;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
