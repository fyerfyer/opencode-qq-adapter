import { resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { ResolvedReplyPlan } from "../../conversation/reply-plan.js";
import type { ActiveRun, RunUsage } from "../../conversation/types.js";
import type { RunStatus } from "../../domain/conversation.js";
import type { IncomingMessage } from "../../domain/message.js";
import type { AuditTrail } from "../../observability/audit.js";
import type { MessageSender } from "../../qq/sender.js";
import type {
  PluginAdminActor,
  PluginAdminResult,
  PluginConfigReloadContext,
  PluginConversationProfile,
  PluginEventMap,
  PluginLogger,
  PluginSessionMutationResult,
} from "../sdk.js";
import { PluginAdminDispatcher } from "./admin.js";
import { PluginCommandDispatcher } from "./commands.js";
import type { PluginContextServices } from "./context.js";
import { createPluginContext } from "./context.js";
import { toPluginConversation } from "./convert.js";
import { PluginHooksDispatcher } from "./hooks.js";
import { PluginLifecycle } from "./lifecycle.js";
import { PluginLoader } from "./loader.js";
import { PluginRegistry } from "./registry.js";
import type {
  PluginCommandInput,
  PluginHostOptions,
  PluginHostStatus,
  PluginProfileResult,
  PluginPromptResult,
  PluginReloadReport,
  PluginRuntimeStatus,
  PluginUiAssetInfo,
  PluginUiPageInfo,
} from "./types.js";
import { UtilityRunner } from "./utility.js";

/**
 * Loads trusted, explicitly configured plugins and exposes a narrow runtime API.
 *
 * Failure isolation is deliberate: a broken plugin is marked failed, while the
 * bridge, other plugins and QQ command handling continue to work.
 */
export class PluginHost {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #audit: AuditTrail;
  readonly #sender: MessageSender;
  readonly #conversations: PluginHostOptions["conversations"];
  readonly #sessionActions: PluginHostOptions["sessionActions"];
  readonly #reserved: Set<string>;
  readonly #coreVersion: string;
  readonly #now: () => number;
  readonly #pluginsDir: string;
  readonly #utility: UtilityRunner;
  readonly #registry: PluginRegistry;
  readonly #loader: PluginLoader;
  readonly #lifecycle: PluginLifecycle;
  readonly #commands: PluginCommandDispatcher;
  readonly #hooks: PluginHooksDispatcher;
  readonly #admin: PluginAdminDispatcher;

  constructor(options: PluginHostOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#sender = options.sender;
    this.#conversations = options.conversations;
    this.#sessionActions = options.sessionActions;
    this.#reserved = new Set([...options.reservedCommands].map((name) => name.toLowerCase()));
    this.#coreVersion = options.coreVersion;
    this.#now = options.now ?? Date.now;
    this.#pluginsDir = resolve(this.#config.storage.plugins_dir);
    this.#utility = new UtilityRunner({
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      config: this.#config,
      logger: this.#logger,
      audit: this.#audit,
      now: this.#now,
    });
    this.#registry = new PluginRegistry();
    this.#loader = new PluginLoader({
      logger: this.#logger,
      audit: this.#audit,
      coreVersion: this.#coreVersion,
      now: this.#now,
      pluginsDir: this.#pluginsDir,
      utility: this.#utility,
      createContext: (instance, pluginOptions) => this.#createContext(instance, pluginOptions),
    });
    this.#lifecycle = new PluginLifecycle({
      config: this.#config,
      logger: this.#logger,
      registry: this.#registry,
      loader: this.#loader,
      withMaintenance: options.withMaintenance ?? ((task) => task()),
    });
    this.#commands = new PluginCommandDispatcher({
      config: this.#config,
      sender: this.#sender,
      logger: this.#logger,
      audit: this.#audit,
      now: this.#now,
      registry: this.#registry,
      conversations: this.#conversations,
    });
    this.#hooks = new PluginHooksDispatcher({
      config: this.#config,
      logger: this.#logger,
      audit: this.#audit,
      now: this.#now,
      registry: this.#registry,
      conversations: this.#conversations,
    });
    this.#admin = new PluginAdminDispatcher({ registry: this.#registry });
  }

  get started(): boolean {
    return this.#lifecycle.started;
  }

  /** Number of plugin command/admin/afterRun tasks still using plugin state. */
  pendingTasks(): number {
    return this.#registry.pendingTasks();
  }

  /** Stop accepting new plugin work while the host is being reconciled. */
  setMaintenance(active: boolean): void {
    this.#registry.setMaintenance(active);
  }

  async start(): Promise<void> {
    return this.#lifecycle.start();
  }

  async reload(): Promise<PluginReloadReport> {
    return this.#lifecycle.reload();
  }

  async reloadPlugin(pluginId: string): Promise<PluginRuntimeStatus> {
    return this.#lifecycle.reloadPlugin(pluginId);
  }

  async stop(): Promise<void> {
    return this.#lifecycle.stop();
  }

  status(): PluginHostStatus {
    return this.#registry.status();
  }

  helpText(): string {
    return this.#registry.helpText();
  }

  /** Validate/normalize raw plugin options with the plugin's own parser. */
  validateOptions(pluginId: string, options: unknown): unknown {
    const instance = this.#registry.get(pluginId);
    if (instance === undefined) {
      throw new Error(`unknown plugin: ${pluginId}`);
    }
    const definition = instance.definition;
    if (definition?.options === undefined) return options;
    try {
      return definition.options.parse(options);
    } catch (error) {
      throw new Error(
        `invalid options for plugin ${pluginId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async dispatchAdmin(
    pluginId: string,
    request: Request,
    path: string,
    actor: PluginAdminActor,
  ): Promise<PluginAdminResult | null> {
    return this.#admin.dispatch(pluginId, request, path, actor);
  }

  adminUiPage(pluginId: string, pageId?: string): PluginUiPageInfo | null {
    return this.#admin.page(pluginId, pageId);
  }

  async resolveAdminUiAsset(
    pluginId: string,
    assetPath: string,
  ): Promise<PluginUiAssetInfo | null> {
    return this.#admin.asset(pluginId, assetPath);
  }

  /** Return true when a plugin handled the command (including permission denial). */
  async dispatchCommand(input: PluginCommandInput): Promise<boolean> {
    return this.#commands.dispatch(input);
  }

  async resolveProfile(message: IncomingMessage, projectId: string): Promise<PluginProfileResult> {
    return this.#hooks.resolveProfile(message, projectId);
  }

  async beforePrompt(
    message: IncomingMessage,
    projectId: string,
    profile: PluginConversationProfile | null = null,
    promptPrefix = "",
  ): Promise<PluginPromptResult> {
    return this.#hooks.beforePrompt(message, projectId, profile, promptPrefix);
  }

  async formatReply(active: ActiveRun, text: string): Promise<ResolvedReplyPlan | null> {
    return this.#hooks.formatReply(active, text);
  }

  async afterRun(
    active: ActiveRun,
    status: RunStatus,
    usage: RunUsage | null,
    error: string | null,
  ): Promise<void> {
    return this.#hooks.afterRun(active, status, usage, error);
  }

  async configReloaded(context: PluginConfigReloadContext): Promise<void> {
    return this.#hooks.configReloaded(context);
  }

  async emit<K extends keyof PluginEventMap>(type: K, event: PluginEventMap[K]): Promise<void> {
    return this.#hooks.emit(type, event);
  }

  #createContext(
    instance: Parameters<typeof createPluginContext>[0],
    options: unknown,
  ): ReturnType<typeof createPluginContext> {
    return createPluginContext(instance, options, {
      config: this.#config,
      sender: this.#sender,
      logger: this.#logger,
      reservedCommands: this.#reserved,
      sortedInstances: () => this.#registry.sorted(),
      conversationSnapshot: (chatKey) =>
        toPluginConversation(this.#conversations.getConversation(chatKey)),
      setProject: (pluginId, chatKey, projectId, actorQq) =>
        this.#setProject(pluginId, chatKey, projectId, actorQq),
      resetSession: (pluginId, chatKey, actorQq) => this.#resetSession(pluginId, chatKey, actorQq),
      completeUtility: (target, input) => this.#utility.complete(target, input),
      pluginLogger: (target) => this.#pluginLogger(target),
    } satisfies PluginContextServices);
  }

  #setProject(
    pluginId: string,
    chatKey: string,
    projectId: string,
    actorQq: number,
  ): PluginSessionMutationResult {
    if (this.#sessionActions === undefined) {
      return { ok: false, reason: "当前 bridge 未提供会话变更能力。" };
    }
    const result = this.#sessionActions.setProject({
      pluginId,
      chatKey,
      projectId,
      actorQq,
    });
    this.#audit.record({
      ts: this.#now(),
      actorQq,
      chatKey,
      projectId,
      workspaceId: null,
      action: result.ok ? "plugin.session_project" : "plugin.session_project_denied",
      detail: { pluginId, projectId, ...(result.reason ? { reason: result.reason } : {}) },
    });
    return result;
  }

  #resetSession(pluginId: string, chatKey: string, actorQq: number): PluginSessionMutationResult {
    if (this.#sessionActions === undefined) {
      return { ok: false, reason: "当前 bridge 未提供会话变更能力。" };
    }
    const conversation = this.#conversations.getConversation(chatKey);
    const result = this.#sessionActions.reset({ pluginId, chatKey, actorQq });
    this.#audit.record({
      ts: this.#now(),
      actorQq,
      chatKey,
      projectId: conversation?.projectId ?? null,
      workspaceId: conversation?.workspaceId ?? null,
      action: result.ok ? "plugin.session_reset" : "plugin.session_reset_denied",
      detail: { pluginId, ...(result.reason ? { reason: result.reason } : {}) },
    });
    return result;
  }

  #pluginLogger(instance: Parameters<typeof createPluginContext>[0]): PluginLogger {
    return this.#logger.child({ pluginId: instance.id });
  }
}
