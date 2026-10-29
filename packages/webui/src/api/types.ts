export interface HealthSnapshot {
  status: "ok" | "degraded" | "error";
  version: string;
  uptimeSec: number;
  timestamp: string;
  onebot: {
    mode: string;
    connected: boolean;
    loginOk: boolean | null;
    selfId: number | null;
    lastEventAt: number | null;
    lastConnectedAt: number | null;
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
    projects: number;
    hiddenProjects: number;
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
  write_projects: string[];
  note?: string;
  hourlyLimit: number | null;
  hourlyUsage: number;
  limits?: {
    prompts_per_minute?: number;
    runs_per_hour?: number | null;
    daily_cost_usd?: number;
    daily_tokens?: number;
  };
}

export interface ProjectRecord {
  id: string;
  path: string;
  description?: string;
  workspace: "shared" | "per_user" | "worktree" | "none";
  agent: string | null;
  model: string | null;
  setup: string[];
  base_branch: string | null;
  hidden: boolean;
  managed_by?: string;
}

export interface AccessSnapshot {
  users: UserRecord[];
  projects: ProjectRecord[];
  defaults: { hourlyLimit: number | null };
  configHash: string | null;
  configPath: string | null;
  warnings: string[];
}

export interface AgentModelCapabilities {
  tools: boolean;
  input: string[];
  output: string[];
}

export interface AgentModelRecord {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  variants: string[];
  capabilities: AgentModelCapabilities | null;
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

export type PromptOwner = "core" | "plugin" | "user";

export interface PromptSummary {
  name: string;
  title: string | null;
  description: string | null;
  model: string | null;
  size: number;
  updatedAt: number;
  backups: number;
  owner: PromptOwner;
  managedBy: string | null;
  editable: boolean;
}

export interface PromptFile extends PromptSummary {
  content: string;
}

export interface OpenCodeReloadResult {
  ok: boolean;
  deferred?: boolean;
  warnings?: string[];
  error?: string;
  activeRuns?: number;
  queuedRuns?: number;
  appliedSessions?: number;
  failedSessions?: number;
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

export interface ConnectionStatus {
  connected: boolean;
  loginOk: boolean | null;
  selfId: number | null;
  lastConnectedAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
}

export interface ConnectionsSnapshot {
  envPath: string | null;
  envHash: string | null;
  napcat: {
    url: string;
    tokenConfigured: boolean;
    status: ConnectionStatus;
  };
}

export interface ConnectionSaveResult extends ConnectionsSnapshot {
  backup: string | null;
  restartRequired: string[];
  warnings: string[];
  reload: {
    ok: boolean;
    warnings: string[];
    error?: string;
  } | null;
}

export interface PluginSecretResult {
  key: string;
  configured: boolean;
  backup: string | null;
  reload: {
    ok: boolean;
    warnings: string[];
    error?: string;
  } | null;
}

export type PluginSourceKind = "path" | "package";

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
  sourceKind: PluginSourceKind;
  managed: boolean;
  loadedAt: number | null;
  admin: {
    routes: number;
    pages: PluginAdminPage[];
  };
}

export interface PluginAdminPage {
  id: string;
  title: string;
  path?: string;
  description?: string;
  kind?: "native" | "iframe";
  entry?: string;
}

export interface PluginPackagePreview {
  uploadId: string | null;
  archive: { name: string; bytes: number; sha256: string } | null;
  manifest: {
    id: string;
    name: string;
    version: string;
    apiVersion: number;
    description: string | null;
    capabilities: string[];
    engines: { opencodeQq: string | null };
    ui: { root: string; entry: string | null } | null;
  };
  entry: string;
  packageName: string | null;
  files: number;
  bytes: number;
  warnings: string[];
  existing: {
    id: string;
    version: string;
    status: PluginInfo["status"];
    managed: boolean;
    sourceKind: PluginSourceKind;
  } | null;
  configHash: string | null;
  configPath: string | null;
}

export interface PluginInstallInfo {
  managed: boolean;
  sourceKind: PluginSourceKind;
  archiveName: string | null;
  archiveSha256: string | null;
  installedAt: number | null;
  previousVersion: string | null;
  backups: number;
}

export interface PluginActionResult {
  plugin: PluginInfo;
  install: PluginInstallInfo | null;
  reload: ConfigSaveResult["reload"];
  warnings: string[];
}

export interface PluginUninstallResult {
  configRemoved: boolean;
  codeRemoved: boolean;
  dataDeleted: boolean;
  reload: ConfigSaveResult["reload"];
  warnings: string[];
}

export interface PluginUiPageDescriptor {
  pluginId: string;
  pageId: string;
  title: string;
  description?: string;
  entry: string;
  protocol: 1;
  url: string;
}

export interface PluginOptionsSnapshot {
  plugin: PluginInfo;
  options: Record<string, unknown>;
  normalized: unknown;
  error: string | null;
  configHash: string | null;
  configPath: string | null;
}

export interface PluginOptionsSaveResult extends PluginOptionsSnapshot, ConfigSaveResult {
  reload: ConfigSaveResult["reload"];
}

export interface RoleplayDiagnostic {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

export interface RoleplaySummary {
  options: Record<string, unknown>;
  personas: { total: number };
  stickers: {
    total: number;
    personas: Array<{ personaId: string; count: number; emotions: string[] }>;
    global: { count: number; emotions: string[] };
  };
  memory: { scopes: number };
  bindings: { total: number };
  paths: {
    personas: string;
    stickers: string;
    memory: string;
    database: string;
  };
  jev: {
    judge: string;
    apiKeyEnv: string;
    apiKeyConfigured: boolean;
    configured: boolean;
    ready: boolean;
  };
  checks: RoleplayDiagnostic[];
}

export interface RoleplayPersonaSummary {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  updatedAt: number;
  worldbook: number;
  stickers: number;
  emotions: string[];
  memoryScopes: number;
  bindings: number;
}

export interface RoleplayWorldbookEntry {
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  caseSensitive: boolean;
  matchWholeWords?: boolean;
  priority: number;
  insertionOrder: number;
  position: "before_char" | "after_char";
}

export interface RoleplayBinding {
  chatKey: string;
  namespace: string;
  personaId: string;
  personaName: string;
  previousProjectId: string | null;
  enabled: boolean;
  updatedAt: number;
}

export interface RoleplayMemoryDoc {
  kind: "user" | "scene";
  kindLabel?: string;
  path: string;
  name?: string;
  content: string;
  exists: boolean;
  updatedAt: number | null;
  size?: number;
  manualSection?: string;
  sections?: string[];
}

export interface RoleplayMemoryScope {
  scope: string;
  chatKey: string | null;
  kind: "private" | "shared";
  label: string;
  actorQq: number | null;
  docs: Array<{
    kind: "user" | "scene";
    actorQq: number | null;
    name: string;
    exists: boolean;
    size: number;
    updatedAt: number | null;
  }>;
}

export interface RoleplayMemoryHistoryEntry {
  name: string;
  path: string;
  createdAt: number;
}

export interface RoleplayStickerFile {
  name: string;
  size: number;
  updatedAt: number;
  url: string;
  thumbnailUrl: string;
}

export interface RoleplayStickerEmotion {
  emotion: string;
  files: RoleplayStickerFile[];
}

export interface RoleplayStickerSet {
  personaId: string;
  emotions: RoleplayStickerEmotion[];
  global: RoleplayStickerEmotion[];
}

export interface RoleplayPersonaDetail {
  persona: {
    id: string;
    name: string;
    dir: string;
    cardPath: string;
    firstMes: string;
    createdAt: number;
    updatedAt: number;
  };
  card: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
  } | null;
  notes: string;
  worldbook: RoleplayWorldbookEntry[];
  stickers: { total: number; emotions: string[] };
  memoryScopes: RoleplayMemoryScope[];
  bindings: RoleplayBinding[];
}
