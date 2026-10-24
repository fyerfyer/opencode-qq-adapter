export interface HealthSnapshot {
  status: "ok" | "degraded" | "error";
  version: string;
  uptimeSec: number;
  timestamp: string;
  onebot: {
    mode: string;
    connected: boolean;
    selfId: number | null;
    lastEventAt: number | null;
    lastError: string | null;
  };
  opencode: {
    mode: string;
    healthy: boolean;
    version: string | null;
    url: string | null;
    checkedAt: number;
    error: string | null;
  };
  db: { ok: boolean };
  queue: { depth: number; active: number };
  conversations: { active: number };
}

export interface AuditRecord {
  id: number;
  ts: number;
  actorQq: number | null;
  chatKey: string | null;
  projectId: string | null;
  workspaceId: string | null;
  action: string;
  detail: unknown;
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
  workspaceId: string | null;
  sessionId: string | null;
  actorQq: number | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  stopReason: string | null;
  error: string | null;
  usageJson: string | null;
}

export interface ApprovalRecord {
  id: string;
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
  status: string;
  requestedAt: number;
  expiresAt: number;
  repliedAt: number | null;
  repliedBy: number | null;
  decision: string | null;
  qqMessageId: string | null;
}

export interface Overview {
  status: HealthSnapshot;
  version: string;
  agentEvents: {
    connected: boolean;
    lastEventAt: number | null;
    lastError: string | null;
  };
  config: {
    path: string | null;
    users: number;
    groups: number;
    projects: number;
    policies: number;
    features: Record<string, boolean>;
  };
  counts: {
    conversations: number;
    workspaces: number;
    pendingApprovals: number;
    activeRuns: number;
  };
  usageToday: DailyUsage[];
  activeRuns: RunRecord[];
  pendingApprovals: ApprovalRecord[];
  recentRuns: RunRecord[];
  recentAudit: AuditRecord[];
}

export interface UserRecord {
  qq: string;
  role: "owner" | "admin" | "member";
  projects: string[];
  policy?: string;
  note?: string;
  limits?: {
    prompts_per_minute?: number;
    runs_per_hour?: number;
    daily_cost_usd?: number;
    daily_tokens?: number;
  };
}

export interface GroupRecord {
  id: string;
  enabled: boolean;
  mode: "per_user" | "shared" | "readonly";
  require_mention?: boolean;
  allowed_users: string[];
  projects: string[];
  default_project?: string;
  policy?: string;
}

export type PermissionEffect = "allow" | "ask" | "deny";

export interface ShellRule {
  pattern: string;
  effect: PermissionEffect;
}

export interface PolicyRecord {
  name: string;
  read?: PermissionEffect;
  glob?: PermissionEffect;
  grep?: PermissionEffect;
  edit?: PermissionEffect;
  write?: PermissionEffect;
  shell?: PermissionEffect;
  webfetch?: PermissionEffect;
  websearch?: PermissionEffect;
  external_directory?: PermissionEffect;
  shell_rules: ShellRule[];
}

export interface ProjectRecord {
  id: string;
  path: string;
  description?: string;
  policy: string;
  workspace: "shared" | "per_user" | "worktree";
  agent: string | null;
  model: string | null;
  allowed_users?: string[];
  allowed_groups?: string[];
  setup: string[];
  base_branch: string | null;
}

export interface AccessSnapshot {
  users: UserRecord[];
  groups: GroupRecord[];
  projects: ProjectRecord[];
  policies: PolicyRecord[];
  configHash: string | null;
  configPath: string | null;
  warnings: string[];
}

export interface ConversationRecord {
  chatKey: string;
  projectId: string;
  workspaceId: string | null;
  sessionId: string | null;
  actorQq: number | null;
  agent: string | null;
  model: string | null;
  createdAt: number;
  lastActiveAt: number;
  activeRun: RunRecord | null;
  pendingApprovals: number;
  recentRuns: RunRecord[];
}

export interface AgentSession {
  id: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  projectId: string | null;
  created: number | null;
  updated: number | null;
  cost: number;
  tokens: unknown;
}

export interface ConfigSnapshot {
  path: string;
  content: string;
  hash: string;
  mtime: number;
  warnings: string[];
}

export interface ConfigSaveResult extends ConfigSnapshot {
  backup: string | null;
  applied: string[];
  restartRequired: string[];
  reload: {
    ok: boolean;
    applied: string[];
    restartRequired: string[];
    warnings: string[];
    error?: string;
  };
}

export interface PromptSummary {
  name: string;
  title: string | null;
  description: string | null;
  size: number;
  updatedAt: number;
  backups: number;
}

export interface PromptFile extends PromptSummary {
  content: string;
}

export interface PromptBackup {
  name: string;
  size: number;
  updatedAt: number;
}

export interface MetaInfo {
  version: string;
  configPath: string | null;
  promptRoot: string;
  admin: {
    allowRemote: boolean;
    sessionHours: number;
  };
  features: Record<string, boolean>;
  defaultProject: string | null;
  plugins: {
    enabled: boolean;
    total: number;
    loaded: number;
    failed: number;
    plugins: PluginInfo[];
    message: string;
  };
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description: string | null;
  status: "disabled" | "loaded" | "failed" | "stopped";
  error: string | null;
  capabilities: string[];
  commands: string[];
  source: string;
  loadedAt: number | null;
}
