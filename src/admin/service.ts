import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { ConfigReloadResult } from "../config/reload.js";
import type {
  AppConfig,
  GroupConfig,
  PolicyConfig,
  ProjectConfig,
  UserConfig,
} from "../config/schema.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { AuditEntry } from "../domain/audit.js";
import type { ConversationRecord, RunRecord } from "../domain/conversation.js";
import type { AuditTrail } from "../observability/audit.js";
import type { HealthService } from "../observability/health.js";
import type { PluginHost, PluginHostStatus } from "../plugins/host.js";
import type { PluginAdminActor, PluginAdminResult } from "../plugins/sdk.js";
import { PLUGIN_UI_PROTOCOL_VERSION } from "../plugins/ui-protocol.js";
import type { AgentModel, AgentPort, AgentSession, AgentSummary } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import {
  AdminAuth,
  type AdminBootstrap,
  type AdminLoginResult,
  type AdminRequestMeta,
} from "./auth.js";
import {
  AdminConfigError,
  ConfigEditor,
  type ConfigSaveResult,
  type ConfigSnapshot,
} from "./config-editor.js";
import { PluginUiTokenSigner } from "./plugin-ui-token.js";
import { type PromptFile, PromptStore, type PromptSummary } from "./prompts.js";

export class AdminError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503;
  readonly code: string;
  readonly details: string[];

  constructor(status: AdminError["status"], code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface AdminServiceOptions {
  config: AppConfig;
  configPath: string | null;
  version: string;
  store: StorePort;
  health: HealthService;
  agent: AgentPort;
  conversations: ConversationManager;
  audit: AuditTrail;
  plugins?: PluginHost;
  logger: Logger;
  reloadConfig: () => Promise<ConfigReloadResult>;
  initialPassword?: string;
  promptRoot?: string;
  /** Test hook for token expiry. */
  now?: () => number;
}

export interface PluginUiPageDescriptor {
  pluginId: string;
  pageId: string;
  title: string;
  description?: string;
  entry: string;
  protocol: typeof PLUGIN_UI_PROTOCOL_VERSION;
  url: string;
}

export interface PluginUiAssetPayload {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export interface AccessSnapshot {
  users: Array<{ qq: string } & UserConfig>;
  groups: Array<{ id: string } & GroupConfig>;
  projects: Array<{ id: string } & ProjectConfig>;
  policies: Array<{ name: string } & PolicyConfig>;
  configHash: string | null;
  configPath: string | null;
  warnings: string[];
}

export interface ConversationOverview extends ConversationRecord {
  activeRun: RunRecord | null;
  pendingApprovals: number;
  recentRuns: RunRecord[];
}

export interface PluginOptionsSnapshot {
  plugin: NonNullable<PluginHostStatus["plugins"][number]>;
  options: Record<string, unknown>;
  normalized: unknown;
  error: string | null;
  configHash: string | null;
  configPath: string | null;
}

export class AdminService {
  readonly auth: AdminAuth;
  readonly configEditor: ConfigEditor;
  readonly prompts: PromptStore;
  readonly #config: AppConfig;
  readonly #configPath: string | null;
  readonly #version: string;
  readonly #store: StorePort;
  readonly #health: HealthService;
  readonly #agent: AgentPort;
  readonly #conversations: ConversationManager;
  readonly #audit: AuditTrail;
  readonly #plugins: PluginHost | undefined;
  readonly #logger: Logger;
  readonly #reloadConfig: () => Promise<ConfigReloadResult>;
  readonly #pluginUiTokens: PluginUiTokenSigner;

  constructor(options: AdminServiceOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#version = options.version;
    this.#store = options.store;
    this.#health = options.health;
    this.#agent = options.agent;
    this.#conversations = options.conversations;
    this.#audit = options.audit;
    this.#plugins = options.plugins;
    this.#logger = options.logger;
    this.#reloadConfig = options.reloadConfig;
    this.#pluginUiTokens = new PluginUiTokenSigner(randomBytes(32), {
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.auth = new AdminAuth({
      store: options.store,
      sessionHours: options.config.admin.session_hours,
      loginAttempts: options.config.admin.login_attempts,
      initialPassword: options.initialPassword,
    });
    this.configEditor = new ConfigEditor({
      configPath: options.configPath,
      reload: options.reloadConfig,
      logger: options.logger,
    });
    this.prompts = new PromptStore({ root: options.promptRoot });
  }

  get configPath(): string | null {
    return this.#configPath;
  }

  updateSettings(): void {
    this.auth.updateSettings(this.#config.admin.session_hours, this.#config.admin.login_attempts);
  }

  async start(): Promise<AdminBootstrap> {
    const bootstrap = await this.auth.start();
    this.#logger.info(
      { created: bootstrap.created, username: bootstrap.username },
      "Admin authentication initialized",
    );
    return bootstrap;
  }

  async login(password: string, meta: AdminRequestMeta): Promise<AdminLoginResult> {
    const result = await this.auth.login(password, meta);
    this.record({
      action: result.ok ? "admin.login" : "admin.login.failed",
      detail: {
        ip: meta.ip,
        reason: result.ok ? undefined : result.reason,
      },
    });
    return result;
  }

  logout(token: string | undefined): void {
    this.auth.logout(token);
    this.record({ action: "admin.logout", detail: {} });
  }

  async changePassword(
    currentPassword: string,
    nextPassword: string,
    token: string,
    meta: AdminRequestMeta,
  ): Promise<{ csrfToken: string }> {
    const result = await this.auth.changePassword(currentPassword, nextPassword, token, meta);
    if (!result.ok) throw new AdminError(400, "password_rejected", result.reason);
    this.record({ action: "admin.password.changed", detail: {} });
    return { csrfToken: result.csrfToken };
  }

  async overview(): Promise<Record<string, unknown>> {
    const status = await this.#health.snapshot();
    const today = dayKey();
    const activeRuns = [
      ...this.#store.runs.listByStatus("running"),
      ...this.#store.runs.listByStatus("waiting_permission"),
      ...this.#store.runs.listByStatus("queued"),
    ];
    const pendingApprovals = this.#store.approvals.listPending();
    const conversations = this.#store.conversations.list();
    const workspaces = this.#store.workspaces.list();
    return {
      status,
      version: this.#version,
      agentEvents: this.#agent.eventStatus(),
      config: {
        path: this.#configPath,
        users: Object.keys(this.#config.users).length,
        groups: Object.keys(this.#config.groups).length,
        projects: Object.keys(this.#config.projects).length,
        policies: Object.keys(this.#config.policies).length,
        features: this.#config.features,
      },
      counts: {
        conversations: conversations.length,
        workspaces: workspaces.length,
        pendingApprovals: pendingApprovals.length,
        activeRuns: activeRuns.length,
      },
      usageToday: this.#store.usage.listDaily(today),
      activeRuns: activeRuns.slice(0, 20),
      pendingApprovals: pendingApprovals.slice(0, 10),
      recentRuns: this.#store.runs.listRecentAll(15),
      recentAudit: this.#audit.listRecent(15),
    };
  }

  async access(): Promise<AccessSnapshot> {
    let hash: string | null = null;
    let warnings: string[] = [];
    if (this.configEditor.enabled) {
      try {
        const snapshot = await this.configEditor.read();
        hash = snapshot.hash;
        warnings = snapshot.warnings;
      } catch (error) {
        this.#logger.warn({ err: error }, "Admin access view could not read config");
      }
    }
    return {
      users: Object.entries(this.#config.users).map(([qq, user]) => ({ qq, ...user })),
      groups: Object.entries(this.#config.groups).map(([id, group]) => ({ id, ...group })),
      projects: Object.entries(this.#config.projects).map(([id, project]) => ({ id, ...project })),
      policies: Object.entries(this.#config.policies).map(([name, policy]) => ({
        name,
        ...policy,
      })),
      configHash: hash,
      configPath: this.#configPath,
      warnings,
    };
  }

  async upsertUser(qq: string, user: UserConfig, expectedHash?: string): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["users", qq], compactObject(user));
    }, expectedHash);
    this.record({
      action: "admin.config.user.upserted",
      detail: { qq, role: user.role },
    });
    return result;
  }

  async deleteUser(qq: string, expectedHash?: string): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.deleteIn(["users", qq]);
    }, expectedHash);
    this.record({ action: "admin.config.user.deleted", detail: { qq } });
    return result;
  }

  async upsertGroup(
    id: string,
    group: GroupConfig,
    expectedHash?: string,
  ): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["groups", id], compactObject(group));
    }, expectedHash);
    this.record({
      action: "admin.config.group.upserted",
      detail: { id, mode: group.mode, enabled: group.enabled },
    });
    return result;
  }

  async deleteGroup(id: string, expectedHash?: string): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.deleteIn(["groups", id]);
    }, expectedHash);
    this.record({ action: "admin.config.group.deleted", detail: { id } });
    return result;
  }

  async upsertProject(
    id: string,
    project: ProjectConfig,
    expectedHash?: string,
  ): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["projects", id], compactObject(project));
    }, expectedHash);
    this.record({
      action: "admin.config.project.upserted",
      detail: { id, path: project.path, workspace: project.workspace },
    });
    return result;
  }

  async deleteProject(id: string, expectedHash?: string): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.deleteIn(["projects", id]);
    }, expectedHash);
    this.record({ action: "admin.config.project.deleted", detail: { id } });
    return result;
  }

  async upsertPolicy(
    name: string,
    policy: PolicyConfig,
    expectedHash?: string,
  ): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["policies", name], compactObject(policy));
    }, expectedHash);
    this.record({ action: "admin.config.policy.upserted", detail: { name } });
    return result;
  }

  async deletePolicy(name: string, expectedHash?: string): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.deleteIn(["policies", name]);
    }, expectedHash);
    this.record({ action: "admin.config.policy.deleted", detail: { name } });
    return result;
  }

  async setDefaultProject(
    projectId: string | null,
    expectedHash?: string,
  ): Promise<ConfigSaveResult> {
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["default_project"], projectId);
    }, expectedHash);
    this.record({ action: "admin.config.default_project", detail: { projectId } });
    return result;
  }

  readConfig(): Promise<ConfigSnapshot> {
    return this.configEditor.read();
  }

  async saveConfig(content: string, expectedHash?: string): Promise<ConfigSaveResult> {
    const result = await this.configEditor.save(content, expectedHash);
    this.record({
      action: "admin.config.updated",
      detail: {
        applied: result.applied,
        restartRequired: result.restartRequired,
        backup: result.backup,
      },
    });
    return result;
  }

  async reloadConfig(): Promise<ConfigReloadResult> {
    const result = await this.configEditor.reload();
    this.updateSettings();
    this.record({
      action: "admin.config.reloaded",
      detail: { ok: result.ok, applied: result.applied, restartRequired: result.restartRequired },
    });
    return result;
  }

  async conversations(): Promise<ConversationOverview[]> {
    return this.#store.conversations.list().map((conversation) => ({
      ...conversation,
      activeRun: this.#store.runs.activeForChat(conversation.chatKey),
      pendingApprovals: this.#store.approvals.findPendingByChat(conversation.chatKey).length,
      recentRuns: this.#store.runs.listRecent(conversation.chatKey, 5),
    }));
  }

  async projectSessions(projectId: string): Promise<AgentSession[]> {
    const project = this.#config.projects[projectId];
    if (project === undefined) throw new AdminError(404, "project_not_found", "项目不存在。");
    try {
      return await this.#agent.listSessions(project.path, 50);
    } catch (error) {
      throw new AdminError(
        503,
        "opencode_unavailable",
        `无法读取 OpenCode 会话：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async conversationModels(projectId?: string): Promise<AgentModel[]> {
    const directory = this.#projectDirectory(projectId);
    try {
      return await this.#agent.listModels(directory);
    } catch (error) {
      throw new AdminError(
        503,
        "opencode_unavailable",
        `无法读取 OpenCode 模型：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async conversationAgents(projectId?: string): Promise<AgentSummary[]> {
    const directory = this.#projectDirectory(projectId);
    try {
      return await this.#agent.listAgents(directory);
    } catch (error) {
      throw new AdminError(
        503,
        "opencode_unavailable",
        `无法读取 OpenCode agents：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async setConversationPreferences(
    chatKey: string,
    preferences: { agent?: string; model?: string },
  ): Promise<void> {
    if (this.#store.conversations.get(chatKey) === null) {
      throw new AdminError(404, "conversation_not_found", "会话不存在。");
    }
    const result = await this.#conversations.setPreferences(chatKey, preferences);
    if (!result.ok) {
      throw new AdminError(409, "conversation_busy", result.reason ?? "切换失败。");
    }
    this.record({
      action: "admin.conversation.preferences",
      detail: { chatKey, ...preferences },
    });
  }

  #projectDirectory(projectId: string | undefined): string | undefined {
    if (projectId === undefined || projectId.length === 0) return undefined;
    const project = this.#config.projects[projectId];
    if (project === undefined) throw new AdminError(404, "project_not_found", "项目不存在。");
    return project.path;
  }

  async switchConversationSession(chatKey: string, sessionId: string): Promise<void> {
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null) throw new AdminError(404, "conversation_not_found", "会话不存在。");
    const sessions = await this.projectSessions(conversation.projectId);
    const session = sessions.find((item) => item.id === sessionId) ?? null;
    if (session === null) {
      throw new AdminError(404, "session_not_found", "该 OpenCode 会话不属于当前项目。");
    }
    const result = this.#conversations.switchSession(chatKey, session);
    if (!result.ok) throw new AdminError(409, "conversation_busy", result.reason ?? "会话正忙。");
    this.record({
      action: "admin.conversation.switched",
      detail: { chatKey, sessionId },
    });
  }

  unbindConversation(chatKey: string): void {
    const result = this.#conversations.resetSession(chatKey);
    if (!result.ok) throw new AdminError(409, "conversation_busy", result.reason ?? "操作失败。");
    this.record({ action: "admin.conversation.unbound", detail: { chatKey } });
  }

  async stopConversation(chatKey: string): Promise<{ stopped: boolean; queuedCleared: number }> {
    const result = await this.#conversations.stop(chatKey);
    this.record({ action: "admin.conversation.stopped", detail: { chatKey, ...result } });
    return result;
  }

  async deleteProjectSession(projectId: string, sessionId: string): Promise<void> {
    const sessions = await this.projectSessions(projectId);
    if (!sessions.some((session) => session.id === sessionId)) {
      throw new AdminError(404, "session_not_found", "该会话不属于此项目，或已被删除。");
    }
    if (this.#store.runs.activeForSession(sessionId) !== null) {
      throw new AdminError(409, "session_busy", "该会话仍有运行中的 run，请先中断后再删除。");
    }
    try {
      await this.#agent.deleteSession(sessionId);
    } catch (error) {
      throw new AdminError(
        503,
        "opencode_unavailable",
        `删除 OpenCode 会话失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Do not leave QQ conversations pointing at a deleted session. The run
    // guard above means there is no active queue entry to conflict with.
    for (const conversation of this.#store.conversations.list()) {
      if (conversation.sessionId === sessionId) {
        this.#store.conversations.setSession(
          conversation.chatKey,
          null,
          conversation.agent,
          conversation.model,
        );
      }
    }
    this.record({
      action: "admin.opencode.session.deleted",
      detail: { projectId, sessionId },
    });
  }

  async promptsList(): Promise<{ root: string; prompts: PromptSummary[] }> {
    return { root: this.prompts.root, prompts: await this.prompts.list() };
  }

  readPrompt(name: string): Promise<PromptFile> {
    return this.prompts.read(name);
  }

  async writePrompt(
    name: string,
    content: string,
    options: { override?: boolean } = {},
  ): Promise<PromptFile> {
    const file = await this.prompts.write(name, content, options);
    this.record({
      action: "admin.prompt.saved",
      detail: { name, override: options.override === true },
    });
    return file;
  }

  async promptBackups(
    name: string,
  ): Promise<Array<{ name: string; size: number; updatedAt: number }>> {
    return this.prompts.backups(name);
  }

  readPromptBackup(name: string, backup: string): Promise<string> {
    return this.prompts.readBackup(name, backup);
  }

  async restorePromptBackup(
    name: string,
    backup: string,
    options: { override?: boolean } = {},
  ): Promise<PromptFile> {
    const file = await this.prompts.restoreBackup(name, backup, options);
    this.record({
      action: "admin.prompt.restored",
      detail: { name, backup, override: options.override === true },
    });
    return file;
  }

  audit(limit: number): unknown[] {
    return this.#audit.listRecent(limit);
  }

  usage(day: string): unknown[] {
    return this.#store.usage.listDaily(day);
  }

  plugins(): PluginHostStatus {
    if (this.#plugins !== undefined) {
      return this.#plugins.status();
    }
    return {
      enabled: false,
      total: 0,
      loaded: 0,
      failed: 0,
      plugins: [],
      message: "插件宿主未启用。",
    };
  }

  async pluginOptions(pluginId: string): Promise<PluginOptionsSnapshot> {
    const plugin = this.#requirePlugin(pluginId);
    const raw = this.#config.plugins[pluginId]?.options ?? {};
    let normalized: unknown = raw;
    let error: string | null = null;
    if (this.#plugins !== undefined) {
      try {
        normalized = this.#plugins.validateOptions(pluginId, raw);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    let configHash: string | null = null;
    if (this.configEditor.enabled) {
      try {
        configHash = (await this.configEditor.read()).hash;
      } catch {
        configHash = null;
      }
    }
    return {
      plugin,
      options: raw,
      normalized,
      error,
      configHash,
      configPath: this.#configPath,
    };
  }

  async setPluginEnabled(
    pluginId: string,
    enabled: boolean,
    expectedHash?: string,
  ): Promise<ConfigSaveResult & { plugin: NonNullable<PluginHostStatus["plugins"][number]> }> {
    this.#requirePlugin(pluginId);
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["plugins", pluginId, "enabled"], enabled);
    }, expectedHash);
    this.record({
      action: enabled ? "admin.plugin.enabled" : "admin.plugin.disabled",
      detail: { pluginId },
    });
    return { ...result, plugin: this.#requirePlugin(pluginId) };
  }

  async savePluginOptions(
    pluginId: string,
    options: Record<string, unknown>,
    expectedHash?: string,
  ): Promise<PluginOptionsSnapshot & ConfigSaveResult> {
    this.#requirePlugin(pluginId);
    if (this.#plugins === undefined) {
      throw new AdminError(503, "plugins_disabled", "插件宿主未启用。");
    }
    let normalized: unknown;
    try {
      normalized = this.#plugins.validateOptions(pluginId, options);
    } catch (error) {
      throw new AdminError(
        400,
        "invalid_plugin_options",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!isPlainRecord(normalized)) {
      throw new AdminError(400, "invalid_plugin_options", "插件配置必须是 JSON 对象。");
    }
    const result = await this.configEditor.mutate((document) => {
      document.setIn(["plugins", pluginId, "options"], normalized);
    }, expectedHash);
    this.record({
      action: "admin.plugin.options.updated",
      detail: { pluginId },
    });
    const refreshed = this.#requirePlugin(pluginId);
    return {
      ...result,
      plugin: refreshed,
      options: normalized,
      normalized,
      error: null,
      configHash: result.hash,
      configPath: result.path,
    };
  }

  pluginUiPage(pluginId: string, pageId?: string): PluginUiPageDescriptor {
    const plugin = this.#requirePlugin(pluginId);
    if (plugin.status !== "loaded") {
      throw new AdminError(409, "plugin_not_loaded", `插件未加载：${pluginId}`);
    }
    if (this.#plugins === undefined) {
      throw new AdminError(503, "plugins_disabled", "插件宿主未启用。");
    }
    const page = this.#plugins.adminUiPage(pluginId, pageId);
    if (page === null) {
      throw new AdminError(
        404,
        "plugin_ui_page_not_found",
        `插件没有可用的 iframe 页面：${pluginId}`,
      );
    }
    const token = this.#pluginUiTokens.sign(pluginId);
    const entry = page.entry.split("/").map(encodeURIComponent).join("/");
    return {
      pluginId,
      pageId: page.page.id,
      title: page.page.title,
      ...(page.page.description !== undefined ? { description: page.page.description } : {}),
      entry: page.entry,
      protocol: PLUGIN_UI_PROTOCOL_VERSION,
      url: `/admin/plugin-assets/${encodeURIComponent(token)}/${encodeURIComponent(pluginId)}/${entry}`,
    };
  }

  async readPluginUiAsset(
    token: string,
    pluginId: string,
    relativePath: string,
  ): Promise<PluginUiAssetPayload> {
    const verified = this.#pluginUiTokens.verify(token);
    if (verified === null || verified.pluginId !== pluginId) {
      throw new AdminError(403, "plugin_ui_token_invalid", "插件页面资源令牌无效或已过期。");
    }
    const plugin = this.#requirePlugin(pluginId);
    if (plugin.status !== "loaded") {
      throw new AdminError(404, "plugin_not_loaded", `插件未加载：${pluginId}`);
    }
    if (this.#plugins === undefined) {
      throw new AdminError(503, "plugins_disabled", "插件宿主未启用。");
    }
    const asset = await this.#plugins.resolveAdminUiAsset(pluginId, relativePath);
    if (asset === null) {
      throw new AdminError(404, "plugin_ui_asset_not_found", "插件页面资源不存在。");
    }
    const bytes = await readFile(asset.path).catch(() => null);
    if (bytes === null) {
      throw new AdminError(404, "plugin_ui_asset_not_found", "插件页面资源不存在。");
    }
    if (bytes.byteLength > 32 * 1024 * 1024) {
      throw new AdminError(413, "plugin_ui_asset_too_large", "插件页面资源过大。");
    }
    return {
      body: new Uint8Array(bytes),
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
    };
  }

  async dispatchPluginAdmin(
    pluginId: string,
    request: Request,
    path: string,
    actor: PluginAdminActor,
  ): Promise<PluginAdminResult> {
    this.#requirePlugin(pluginId);
    if (this.#plugins === undefined) {
      throw new AdminError(503, "plugins_disabled", "插件宿主未启用。");
    }
    let result: PluginAdminResult | null;
    try {
      result = await this.#plugins.dispatchAdmin(pluginId, request, path, actor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AdminError(
        /unknown plugin|not loaded/.test(message) ? 404 : 500,
        "plugin_admin_failed",
        message,
      );
    }
    if (result === null) {
      throw new AdminError(404, "plugin_route_not_found", "插件没有这个管理接口。");
    }
    if (!(result instanceof Response) && request.method !== "GET") {
      this.record({
        action: "admin.plugin.route",
        detail: { pluginId, method: request.method, path },
      });
    }
    return result;
  }

  #requirePlugin(pluginId: string): NonNullable<PluginHostStatus["plugins"][number]> {
    const status = this.plugins();
    const plugin = status.plugins.find((item) => item.id === pluginId);
    if (plugin === undefined) {
      throw new AdminError(404, "plugin_not_found", `插件不存在：${pluginId}`);
    }
    return plugin;
  }

  record(
    entry: Omit<AuditEntry, "ts" | "actorQq" | "chatKey" | "projectId" | "workspaceId">,
  ): void {
    this.#audit.record({
      ts: Date.now(),
      actorQq: null,
      chatKey: null,
      projectId: null,
      workspaceId: null,
      ...entry,
    });
  }
}

function compactObject<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dayKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export { AdminConfigError };
