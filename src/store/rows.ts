import type { AdminSessionRecord, AdminUserRecord } from "../domain/admin.js";
import type { ApprovalRecord, ApprovalStatus } from "../domain/approval.js";
import type { AuditRecord, DailyUsage } from "../domain/audit.js";
import type { ConversationRecord, RunRecord, RunStatus } from "../domain/conversation.js";
import type { ApprovalDecision } from "../domain/permission.js";
import type { WorkspaceRecord } from "../domain/workspace.js";

export interface ConversationRow {
  chat_key: string;
  project_id: string;
  workspace_id: string | null;
  session_id: string | null;
  actor_qq: number | null;
  agent: string | null;
  model: string | null;
  created_at: number;
  last_active_at: number;
}

export interface RunRow {
  id: string;
  chat_key: string;
  project_id: string;
  workspace_id: string | null;
  session_id: string | null;
  actor_qq: number | null;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  stop_reason: string | null;
  error: string | null;
  usage_json: string | null;
}

export interface WorkspaceRow {
  id: string;
  project_id: string;
  /** Legacy databases may contain older kinds; readers normalize to shared. */
  kind: string;
  path: string;
  branch: string | null;
  owner_chat_key: string | null;
  /** Legacy databases may contain older statuses; readers normalize to idle. */
  status: string;
  locked_by_run_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  last_used_at: number;
}

export interface ApprovalRow {
  id: string;
  short_id: string;
  run_id: string | null;
  chat_key: string;
  actor_qq: number;
  project_id: string;
  session_id: string;
  permission_id: string;
  action: string;
  resources_json: string;
  message: string | null;
  status: ApprovalStatus;
  requested_at: number;
  expires_at: number;
  replied_at: number | null;
  replied_by: number | null;
  decision: ApprovalDecision | null;
  qq_message_id: string | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor_qq: number | null;
  chat_key: string | null;
  project_id: string | null;
  workspace_id: string | null;
  action: string;
  detail_json: string;
}

export interface UsageRow {
  day: string;
  actor_qq: number;
  project_id: string;
  prompts: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface AdminUserRow {
  username: string;
  password_hash: string;
  must_change_password: number;
  created_at: number;
  updated_at: number;
}

export interface AdminSessionRow {
  token_hash: string;
  username: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
  ip: string | null;
}

export function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    chatKey: row.chat_key,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    actorQq: row.actor_qq,
    agent: row.agent,
    model: row.model,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    chatKey: row.chat_key,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    actorQq: row.actor_qq,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stopReason: row.stop_reason,
    error: row.error,
    usageJson: row.usage_json,
  };
}

export function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "shared",
    path: row.path,
    branch: row.branch,
    ownerChatKey: row.owner_chat_key,
    status: row.status === "locked" ? "locked" : "idle",
    lockedByRunId: row.locked_by_run_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    shortId: row.short_id,
    runId: row.run_id,
    chatKey: row.chat_key,
    actorQq: row.actor_qq,
    projectId: row.project_id,
    sessionId: row.session_id,
    permissionId: row.permission_id,
    action: row.action,
    resources: parseStringArray(row.resources_json),
    message: row.message,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    repliedAt: row.replied_at,
    repliedBy: row.replied_by,
    decision: row.decision,
    qqMessageId: row.qq_message_id,
  };
}

export function mapAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    ts: row.ts,
    actorQq: row.actor_qq,
    chatKey: row.chat_key,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    action: row.action,
    detail: parseJson(row.detail_json),
  };
}

export function mapAdminUser(row: AdminUserRow): AdminUserRecord {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAdminSession(row: AdminSessionRow): AdminSessionRecord {
  return {
    tokenHash: row.token_hash,
    username: row.username,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

export function mapUsage(row: UsageRow): DailyUsage {
  return {
    day: row.day,
    actorQq: row.actor_qq === 0 ? null : row.actor_qq,
    projectId: row.project_id === "" ? null : row.project_id,
    prompts: row.prompts,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  };
}

export function emptyUsage(
  day: string,
  actorQq: number | null,
  projectId: string | null,
): DailyUsage {
  return { day, actorQq, projectId, prompts: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: "unserializable detail" });
  }
}
