import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig, PluginConfig } from "../../config/schema.js";
import type { ResolvedReplyPlan } from "../../conversation/reply-plan.js";
import type { ActiveRun, RunUsage } from "../../conversation/types.js";
import type { RunStatus } from "../../domain/conversation.js";
import type { IncomingMessage } from "../../domain/message.js";
import type { AuditTrail } from "../../observability/audit.js";
import type { MessageSender } from "../../qq/sender.js";
import { loadPluginModule, PluginLoadError } from "../manifest.js";
import { PluginMessageService } from "../messages.js";
import type {
  PluginAdminActor,
  PluginAdminResult,
  PluginChat,
  PluginCommandContext,
  PluginCommandDefinition,
  PluginConfigReloadContext,
  PluginContext,
  PluginConversation,
  PluginConversationProfile,
  PluginEventMap,
  PluginHooksDefinition,
  PluginLogger,
  PluginProfileContext,
  PluginPromptContext,
  PluginReplyContext,
  PluginRunContext,
  PluginRunStatus,
  PluginSessionMutationResult,
} from "../sdk.js";
import {
  dispatchAdminRoute,
  resolveAdminUiPage,
  resolveAdminUiAsset as resolveUiAsset,
} from "./admin-ui.js";
import { createPluginContext } from "./context.js";
import {
  CHAT_TYPES,
  describeError,
  groupIdFromChatKey,
  isPromptPatch,
  isRecord,
  parseOptions,
  ROLES,
  requireCapability,
  sameSpec,
  toPluginChat,
  toPluginMessage,
  withTimeout,
} from "./convert.js";
import { normalizePluginProfile } from "./profile.js";
import { normalizeReplyPlan } from "./reply-plan.js";
import type {
  PluginCommandInput,
  PluginConversationSource,
  PluginHostOptions,
  PluginHostStatus,
  PluginInstance,
  PluginProfileResult,
  PluginPromptResult,
  PluginReloadReport,
  PluginRuntimeStatus,
  PluginSessionActions,
  PluginStatus,
  PluginUiAssetInfo,
  PluginUiPageInfo,
  RegisteredCommand,
  RegisteredHook,
} from "./types.js";
import { UtilityRunner } from "./utility.js";

const HOOK_TIMEOUT_MS = 2_000;
const REPLY_HOOK_TIMEOUT_MS = 4_000;
const EVENT_TIMEOUT_MS = 2_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;

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
  readonly #conversations: PluginConversationSource;
  readonly #sessionActions: PluginSessionActions | undefined;
  readonly #reserved: Set<string>;
  readonly #coreVersion: string;
  readonly #now: () => number;
  readonly #pluginsDir: string;
  readonly #instances = new Map<string, PluginInstance>();
  readonly #utility: UtilityRunner;
  #started = false;

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
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#reconcile();
  }

  async reload(): Promise<PluginReloadReport> {
    if (!this.#started) return { loaded: 0, failed: 0, removed: 0 };
    return this.#reconcile();
  }

  /**
   * Force-dispose and re-import one plugin from its configured path.
   *
   * Unlike `reload()`, this bypasses `sameSpec` so changed code on disk is
   * picked up even when the plugin config is unchanged.
   */
  async reloadPlugin(pluginId: string): Promise<PluginRuntimeStatus> {
    if (!this.#started) return "stopped";
    const existing = this.#instances.get(pluginId);
    if (existing === undefined) throw new Error(`unknown plugin: ${pluginId}`);
    const spec = this.#config.plugins[pluginId];
    if (spec === undefined) {
      throw new Error(
        `plugin ${pluginId} is no longer present in config.plugins; reload the host instead`,
      );
    }

    const order = existing.order;
    await this.#dispose(existing);
    const instance = spec.enabled
      ? await this.#load(pluginId, order, spec)
      : this.#disabledInstance(pluginId, order, spec);
    this.#instances.set(pluginId, instance);
    this.#logger.info({ pluginId, status: instance.status, order }, "Plugin reloaded");
    return instance.status;
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    const instances = this.#sorted();
    for (const instance of instances.reverse()) {
      await this.#dispose(instance);
    }
    this.#instances.clear();
  }

  status(): PluginHostStatus {
    const plugins = this.#sorted().map((instance) => this.#statusOf(instance));
    const loaded = plugins.filter((plugin) => plugin.status === "loaded").length;
    const failed = plugins.filter((plugin) => plugin.status === "failed").length;
    return {
      enabled: true,
      total: plugins.length,
      loaded,
      failed,
      plugins,
      message:
        plugins.length === 0
          ? "配置中没有启用任何插件。"
          : failed > 0
            ? `${loaded} 个插件已加载，${failed} 个失败；失败插件不会影响核心。`
            : `${loaded} 个插件已加载。`,
    };
  }

  helpText(): string {
    const lines: string[] = [];
    for (const instance of this.#sorted()) {
      if (instance.status !== "loaded") continue;
      const commands = [...instance.commands.values()].sort((a, b) =>
        a.definition.name.localeCompare(b.definition.name),
      );
      for (const { definition } of commands) {
        const usage = definition.usage ?? definition.name;
        const description = definition.description ?? "插件命令";
        lines.push(`!${usage} — ${description}（${instance.id}）`);
      }
    }
    return lines.length === 0 ? "" : ["插件", ...lines].join("\n");
  }

  /** Validate/normalize raw plugin options with the plugin's own parser. */
  validateOptions(pluginId: string, options: unknown): unknown {
    const instance = this.#instances.get(pluginId);
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

  /**
   * Dispatch an authenticated admin request to a plugin-owned route.
   * Returns null when no route matches. The core keeps auth, CSRF and audit.
   */
  async dispatchAdmin(
    pluginId: string,
    request: Request,
    path: string,
    actor: PluginAdminActor,
  ): Promise<PluginAdminResult | null> {
    const instance = this.#instances.get(pluginId);
    if (instance === undefined) throw new Error(`unknown plugin: ${pluginId}`);
    if (instance.status !== "loaded") {
      throw new Error(`plugin ${pluginId} is not loaded (status: ${instance.status})`);
    }
    requireCapability(instance, "admin");
    return dispatchAdminRoute(instance, request, path, actor);
  }

  /**
   * Resolve an iframe admin page and its HTML entry. The returned root is
   * internal; callers must never expose it to the browser.
   */
  adminUiPage(pluginId: string, pageId?: string): PluginUiPageInfo | null {
    const instance = this.#instances.get(pluginId);
    if (instance === undefined) return null;
    return resolveAdminUiPage(instance, pageId);
  }

  /** Resolve a static UI asset, following symlinks only when they stay in root. */
  async resolveAdminUiAsset(
    pluginId: string,
    assetPath: string,
  ): Promise<PluginUiAssetInfo | null> {
    const instance = this.#instances.get(pluginId);
    if (instance === undefined) return null;
    return resolveUiAsset(instance, assetPath);
  }

  /** Return true when a plugin handled the command (including permission denial). */
  async dispatchCommand(input: PluginCommandInput): Promise<boolean> {
    const found = this.#findCommand(input.name);
    if (found === null) return false;
    const { instance, command } = found;
    const definition = command.definition;
    const actor = input.message.userId;
    const chat = toPluginChat(input.message.chat);
    const logger = this.#pluginLogger(instance);

    if (!(await this.#authorize(instance, command, input, chat, logger))) {
      return true;
    }

    const messages = new PluginMessageService({
      config: this.#config,
      sender: this.#sender,
      logger,
      dataDir: instance.dataDir,
    }).createApi();

    const conversation = this.#conversationSnapshot(input.message.chat.chatKey);
    const context: PluginCommandContext = {
      message: toPluginMessage(input.message),
      args: input.args,
      rawArgs: input.rawArgs,
      actor: { qq: actor, role: input.actor },
      groupMode: input.groupMode,
      conversation,
      logger,
      reply: (text) => messages.reply(toPluginMessage(input.message), text),
      sendImage: (image) => messages.sendImage(chat, image),
      sendFile: (file) => messages.sendFile(chat, file),
    };

    try {
      const result = await definition.handler(context);
      if (typeof result === "string" && result.trim().length > 0) {
        await context.reply(result);
      }
      this.#audit.record({
        ts: this.#now(),
        actorQq: actor,
        chatKey: input.message.chat.chatKey,
        projectId: conversation?.projectId ?? null,
        workspaceId: conversation?.workspaceId ?? null,
        action: "plugin.command",
        detail: {
          pluginId: instance.id,
          command: definition.name,
          args: input.args.length,
        },
      });
    } catch (error) {
      const message = describeError(error);
      logger.error({ err: error, command: definition.name }, "Plugin command failed");
      this.#audit.record({
        ts: this.#now(),
        actorQq: actor,
        chatKey: input.message.chat.chatKey,
        projectId: conversation?.projectId ?? null,
        workspaceId: conversation?.workspaceId ?? null,
        action: "plugin.command_failed",
        detail: { pluginId: instance.id, command: definition.name, error: message },
      });
      await this.#sender
        .reply(input.message.chat, input.message.id, `插件命令执行失败：${message}`)
        .catch(() => undefined);
    }
    return true;
  }

  /** Resolve a plugin-provided run profile before prompt injection and queueing. */
  async resolveProfile(message: IncomingMessage, projectId: string): Promise<PluginProfileResult> {
    const hooks = this.#loadedHooks("resolveConversationProfile");
    if (hooks.length === 0) return { profile: null, plugins: [] };

    const base: PluginProfileContext = {
      message: toPluginMessage(message),
      projectId,
      conversation: this.#conversationSnapshot(message.chat.chatKey),
    };
    for (const { instance, hook } of hooks) {
      const handler = hook.definition.resolveConversationProfile;
      if (handler === undefined) continue;
      try {
        const raw = await withTimeout(
          Promise.resolve(handler(base)),
          HOOK_TIMEOUT_MS,
          `resolveConversationProfile hook of ${instance.id}`,
        );
        if (!isRecord(raw)) continue;
        const profile = await normalizePluginProfile({
          raw,
          projectId,
          pluginId: instance.id,
          config: this.#config,
          logger: this.#logger,
        });
        if (profile !== null) return { profile, plugins: [instance.id] };
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id, projectId },
          "Plugin resolveConversationProfile hook failed; continuing",
        );
      }
    }
    return { profile: null, plugins: [] };
  }

  async beforePrompt(
    message: IncomingMessage,
    projectId: string,
    profile: PluginConversationProfile | null = null,
  ): Promise<PluginPromptResult> {
    const hooks = this.#loadedHooks("beforePrompt");
    if (hooks.length === 0) {
      return { text: message.text, modified: false, plugins: [] };
    }

    const base: PluginPromptContext = {
      message: toPluginMessage(message),
      projectId,
      conversation: this.#conversationSnapshot(message.chat.chatKey),
      profile,
    };
    const prepends: string[] = [];
    const appends: string[] = [];
    const plugins: string[] = [];

    for (const { instance, hook } of hooks) {
      const handler = hook.definition.beforePrompt;
      if (handler === undefined) continue;
      try {
        const patch = await withTimeout(
          Promise.resolve(handler(base)),
          HOOK_TIMEOUT_MS,
          `beforePrompt hook of ${instance.id}`,
        );
        if (!isPromptPatch(patch)) continue;
        if (typeof patch.prepend === "string" && patch.prepend.trim().length > 0) {
          prepends.push(patch.prepend.trim());
          plugins.push(instance.id);
        }
        if (typeof patch.append === "string" && patch.append.trim().length > 0) {
          appends.push(patch.append.trim());
          plugins.push(instance.id);
        }
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id },
          "Plugin beforePrompt hook failed; continuing",
        );
      }
    }

    if (prepends.length === 0 && appends.length === 0) {
      return { text: message.text, modified: false, plugins: [] };
    }
    const text = [...prepends, message.text, ...appends]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
    return { text, modified: text !== message.text, plugins: [...new Set(plugins)] };
  }

  /** Let a plugin shape the final reply into ordered segments. */
  async formatReply(active: ActiveRun, text: string): Promise<ResolvedReplyPlan | null> {
    const hooks = this.#loadedHooks("formatReply");
    if (hooks.length === 0) return null;
    const context: PluginReplyContext = {
      message: toPluginMessage(active.message),
      projectId: active.record.projectId,
      conversation: this.#conversationSnapshot(active.message.chat.chatKey),
      profile: active.profile ?? null,
      text,
    };
    for (const { instance, hook } of hooks) {
      const handler = hook.definition.formatReply;
      if (handler === undefined) continue;
      try {
        const raw = await withTimeout(
          Promise.resolve(handler(context)),
          REPLY_HOOK_TIMEOUT_MS,
          `formatReply hook of ${instance.id}`,
        );
        const plan = await normalizeReplyPlan({
          instance,
          active,
          value: raw,
          config: this.#config,
          logger: this.#logger,
          audit: this.#audit,
          now: this.#now,
        });
        if (plan !== null) return plan;
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id, runId: active.record.id },
          "Plugin formatReply hook failed; sending the original reply",
        );
      }
    }
    return null;
  }

  async afterRun(
    active: ActiveRun,
    status: RunStatus,
    usage: RunUsage | null,
    error: string | null,
  ): Promise<void> {
    if (status !== "completed" && status !== "failed" && status !== "interrupted") return;
    const context: PluginRunContext = {
      runId: active.record.id,
      chat: toPluginChat(active.message.chat),
      userId: active.message.userId,
      senderName: active.message.senderName,
      projectId: active.record.projectId,
      workspaceId: active.workspaceId,
      sessionId: active.record.sessionId,
      status: status as PluginRunStatus,
      usage: usage === null ? null : { cost: usage.cost, tokens: { ...usage.tokens } },
      error,
      durationMs: Math.max(0, this.#now() - active.record.startedAt),
      promptText: active.message.text,
      userText: active.rawText ?? active.message.text,
      replyText: active.replyText ?? null,
    };

    for (const { instance, hook } of this.#loadedHooks("afterRun")) {
      const handler = hook.definition.afterRun;
      if (handler === undefined) continue;
      try {
        await withTimeout(
          Promise.resolve(handler(context)),
          HOOK_TIMEOUT_MS,
          `afterRun hook of ${instance.id}`,
        );
      } catch (hookError) {
        this.#logger.warn(
          { err: hookError, pluginId: instance.id, runId: context.runId },
          "Plugin afterRun hook failed; continuing",
        );
      }
    }
    await this.emit("run.finished", context);
  }

  async configReloaded(context: PluginConfigReloadContext): Promise<void> {
    for (const { instance, hook } of this.#loadedHooks("onConfigReload")) {
      const handler = hook.definition.onConfigReload;
      if (handler === undefined) continue;
      try {
        await withTimeout(
          Promise.resolve(handler(context)),
          HOOK_TIMEOUT_MS,
          `onConfigReload hook of ${instance.id}`,
        );
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id },
          "Plugin onConfigReload hook failed; continuing",
        );
      }
    }
    await this.emit("config.reloaded", context);
  }

  async emit<K extends keyof PluginEventMap>(type: K, event: PluginEventMap[K]): Promise<void> {
    for (const instance of this.#sorted()) {
      if (instance.status !== "loaded") continue;
      for (const subscription of instance.events) {
        if (subscription.type !== type) continue;
        try {
          await withTimeout(
            Promise.resolve(subscription.handler(event)),
            EVENT_TIMEOUT_MS,
            `${type} event of ${instance.id}`,
          );
        } catch (error) {
          this.#logger.warn(
            { err: error, pluginId: instance.id, event: type },
            "Plugin event handler failed; continuing",
          );
        }
      }
    }
  }

  async #reconcile(): Promise<PluginReloadReport> {
    const entries = Object.entries(this.#config.plugins);
    const desired = new Set(entries.map(([id]) => id));
    let removed = 0;
    for (const [id, instance] of [...this.#instances.entries()]) {
      if (!desired.has(id)) {
        await this.#dispose(instance);
        this.#instances.delete(id);
        removed += 1;
      }
    }

    let loaded = 0;
    let failed = 0;
    for (const [order, [id, spec]] of entries.entries()) {
      const existing = this.#instances.get(id);
      const unchanged =
        existing !== undefined &&
        sameSpec(existing.spec, spec) &&
        (existing.status === "loaded" || existing.status === "disabled");
      if (unchanged) {
        existing.order = order;
        if (existing.status === "loaded") loaded += 1;
        continue;
      }

      if (existing !== undefined) {
        await this.#dispose(existing);
        this.#instances.delete(id);
      }

      if (!spec.enabled) {
        this.#instances.set(id, this.#disabledInstance(id, order, spec));
        continue;
      }

      const instance = await this.#load(id, order, spec);
      this.#instances.set(id, instance);
      if (instance.status === "loaded") loaded += 1;
      else if (instance.status === "failed") failed += 1;
    }

    this.#logger.info(
      { loaded, failed, removed, total: this.#instances.size },
      "Plugin host reconciled",
    );
    return { loaded, failed, removed };
  }

  #disabledInstance(id: string, order: number, spec: PluginConfig): PluginInstance {
    return {
      id,
      order,
      spec,
      status: "disabled",
      error: null,
      manifest: null,
      definition: null,
      context: null,
      packageRoot: null,
      dataDir: join(this.#pluginsDir, id),
      commands: new Map(),
      hooks: [],
      events: [],
      adminRoutes: [],
      adminPages: [],
      disposers: [],
      loadedAt: null,
    };
  }

  async #load(id: string, order: number, spec: PluginConfig): Promise<PluginInstance> {
    const instance: PluginInstance = {
      id,
      order,
      spec,
      status: "failed",
      error: null,
      manifest: null,
      definition: null,
      context: null,
      packageRoot: null,
      dataDir: join(this.#pluginsDir, id),
      commands: new Map(),
      hooks: [],
      events: [],
      adminRoutes: [],
      adminPages: [],
      disposers: [],
      loadedAt: null,
    };

    try {
      const loaded = await loadPluginModule(spec, id, this.#coreVersion);
      instance.manifest = loaded.manifest;
      instance.definition = loaded.definition;
      instance.packageRoot = loaded.packageRoot;
      await mkdir(instance.dataDir, { recursive: true, mode: 0o700 });
      this.#utility.reset(id);
      const options = parseOptions(loaded, spec.options);
      const context = this.#createContext(instance, options);
      instance.context = context;
      const disposer = await withTimeout(
        Promise.resolve(loaded.definition.setup(context)),
        LIFECYCLE_TIMEOUT_MS,
        `setup of ${id}`,
      );
      if (typeof disposer === "function") instance.disposers.push(disposer);
      if (loaded.definition.start !== undefined) {
        await withTimeout(
          Promise.resolve(loaded.definition.start(context)),
          LIFECYCLE_TIMEOUT_MS,
          `start of ${id}`,
        );
      }
      instance.status = "loaded";
      instance.loadedAt = this.#now();
      this.#logger.info(
        {
          pluginId: id,
          version: loaded.manifest.version,
          capabilities: loaded.manifest.capabilities,
          entry: loaded.entryPath,
        },
        "Plugin loaded",
      );
      this.#audit.record({
        ts: this.#now(),
        actorQq: null,
        chatKey: null,
        projectId: null,
        workspaceId: null,
        action: "plugin.loaded",
        detail: { pluginId: id, version: loaded.manifest.version },
      });
      return instance;
    } catch (error) {
      instance.status = "failed";
      instance.error = describeError(error);
      await this.#dispose(instance);
      this.#logger.warn(
        { err: error, pluginId: id, code: error instanceof PluginLoadError ? error.code : null },
        "Plugin failed to load; core continues",
      );
      this.#audit.record({
        ts: this.#now(),
        actorQq: null,
        chatKey: null,
        projectId: null,
        workspaceId: null,
        action: "plugin.failed",
        detail: { pluginId: id, error: instance.error },
      });
      return instance;
    }
  }

  async #dispose(instance: PluginInstance): Promise<void> {
    await this.#utility.dispose(instance.id);

    if (instance.definition?.stop !== undefined && instance.context !== null) {
      try {
        await withTimeout(
          Promise.resolve(instance.definition.stop(instance.context)),
          LIFECYCLE_TIMEOUT_MS,
          `stop of ${instance.id}`,
        );
      } catch (error) {
        this.#logger.warn({ err: error, pluginId: instance.id }, "Plugin stop failed");
      }
    }
    for (const disposer of instance.disposers.reverse()) {
      try {
        await withTimeout(
          Promise.resolve(disposer()),
          LIFECYCLE_TIMEOUT_MS,
          `dispose of ${instance.id}`,
        );
      } catch (error) {
        this.#logger.warn({ err: error, pluginId: instance.id }, "Plugin disposer failed");
      }
    }
    instance.disposers.length = 0;
    instance.commands.clear();
    instance.hooks.length = 0;
    instance.events.length = 0;
    instance.adminRoutes.length = 0;
    instance.adminPages.length = 0;
    if (instance.status === "loaded") instance.status = "stopped";
  }

  #createContext(instance: PluginInstance, options: unknown): PluginContext<unknown> {
    return createPluginContext(instance, options, {
      config: this.#config,
      sender: this.#sender,
      logger: this.#logger,
      reservedCommands: this.#reserved,
      sortedInstances: () => this.#sorted(),
      conversationSnapshot: (chatKey) => this.#conversationSnapshot(chatKey),
      setProject: (chatKey, projectId, actorQq) => this.#setProject(chatKey, projectId, actorQq),
      resetSession: (chatKey, actorQq) => this.#resetSession(chatKey, actorQq),
      completeUtility: (target, input) => this.#utility.complete(target, input),
      pluginLogger: (target) => this.#pluginLogger(target),
    });
  }

  #setProject(chatKey: string, projectId: string, actorQq: number): PluginSessionMutationResult {
    if (this.#sessionActions === undefined) {
      return { ok: false, reason: "当前 bridge 未提供会话变更能力。" };
    }
    const groupId = groupIdFromChatKey(chatKey);
    const result = this.#sessionActions.setProject({
      chatKey,
      projectId,
      actorQq,
      ...(groupId !== undefined ? { groupId } : {}),
    });
    this.#audit.record({
      ts: this.#now(),
      actorQq,
      chatKey,
      projectId,
      workspaceId: null,
      action: result.ok ? "plugin.session_project" : "plugin.session_project_denied",
      detail: { projectId, ...(result.reason ? { reason: result.reason } : {}) },
    });
    return result;
  }

  #resetSession(chatKey: string, actorQq: number): PluginSessionMutationResult {
    if (this.#sessionActions === undefined) {
      return { ok: false, reason: "当前 bridge 未提供会话变更能力。" };
    }
    const conversation = this.#conversations.getConversation(chatKey);
    const result = this.#sessionActions.reset({ chatKey, actorQq });
    this.#audit.record({
      ts: this.#now(),
      actorQq,
      chatKey,
      projectId: conversation?.projectId ?? null,
      workspaceId: conversation?.workspaceId ?? null,
      action: result.ok ? "plugin.session_reset" : "plugin.session_reset_denied",
      detail: { ...(result.reason ? { reason: result.reason } : {}) },
    });
    return result;
  }

  #loadedHooks<K extends keyof PluginHooksDefinition>(
    key: K,
  ): Array<{ instance: PluginInstance; hook: RegisteredHook }> {
    const result: Array<{ instance: PluginInstance; hook: RegisteredHook }> = [];
    for (const instance of this.#sorted()) {
      if (instance.status !== "loaded") continue;
      for (const hook of instance.hooks) {
        if (hook.definition[key] !== undefined) result.push({ instance, hook });
      }
    }
    return result;
  }

  #findCommand(name: string): { instance: PluginInstance; command: RegisteredCommand } | null {
    const normalized = name.toLowerCase();
    for (const instance of this.#sorted()) {
      if (instance.status !== "loaded") continue;
      for (const command of instance.commands.values()) {
        if (command.names.includes(normalized)) return { instance, command };
      }
    }
    return null;
  }

  async #authorize(
    instance: PluginInstance,
    command: RegisteredCommand,
    input: PluginCommandInput,
    chat: PluginChat,
    logger: PluginLogger,
  ): Promise<boolean> {
    const definition = command.definition;
    const roles = definition.roles ?? ROLES;
    if (!roles.includes(input.actor)) {
      await this.#sender
        .reply(
          input.message.chat,
          input.message.id,
          `命令 !${definition.name} 需要 ${roles.join("/")} 权限。`,
        )
        .catch(() => undefined);
      this.#auditDenied(instance, definition, input, "role");
      return false;
    }
    const chats = definition.chats ?? CHAT_TYPES;
    if (!chats.includes(chat.type)) {
      await this.#sender
        .reply(
          input.message.chat,
          input.message.id,
          `命令 !${definition.name} 不支持当前会话类型。`,
        )
        .catch(() => undefined);
      this.#auditDenied(instance, definition, input, "chat_type");
      return false;
    }
    if (
      chat.type === "group" &&
      input.groupMode === "shared" &&
      definition.allowGroupShared !== true
    ) {
      logger.debug({ command: definition.name }, "Shared-group plugin command denied");
      await this.#sender
        .reply(
          input.message.chat,
          input.message.id,
          `命令 !${definition.name} 未授权在 shared 群中使用。`,
        )
        .catch(() => undefined);
      this.#auditDenied(instance, definition, input, "group_shared");
      return false;
    }
    return true;
  }

  #auditDenied(
    instance: PluginInstance,
    command: PluginCommandDefinition,
    input: PluginCommandInput,
    reason: string,
  ): void {
    this.#audit.record({
      ts: this.#now(),
      actorQq: input.message.userId,
      chatKey: input.message.chat.chatKey,
      projectId: null,
      workspaceId: null,
      action: "plugin.command_denied",
      detail: { pluginId: instance.id, command: command.name, reason },
    });
  }

  #conversationSnapshot(chatKey: string): PluginConversation | null {
    const conversation = this.#conversations.getConversation(chatKey);
    if (conversation === null) return null;
    return {
      projectId: conversation.projectId,
      workspaceId: conversation.workspaceId,
      sessionId: conversation.sessionId,
      agent: conversation.agent,
      model: conversation.model,
    };
  }

  #pluginLogger(instance: PluginInstance): PluginLogger {
    return this.#logger.child({ pluginId: instance.id });
  }

  #sorted(): PluginInstance[] {
    return [...this.#instances.values()].sort((left, right) => left.order - right.order);
  }

  #statusOf(instance: PluginInstance): PluginStatus {
    const manifest = instance.manifest;
    return {
      id: instance.id,
      name: manifest?.name ?? instance.id,
      version: manifest?.version ?? "-",
      apiVersion: manifest?.apiVersion ?? 0,
      description: manifest?.description ?? null,
      status: instance.status,
      error: instance.error,
      capabilities: manifest?.capabilities ?? [],
      commands: [...instance.commands.values()].map((command) => command.definition.name).sort(),
      source: instance.spec.package ?? instance.spec.path ?? "",
      sourceKind: instance.spec.package === undefined ? "path" : "package",
      loadedAt: instance.loadedAt,
      admin: {
        routes: instance.adminRoutes.length,
        pages: [...instance.adminPages],
      },
    };
  }
}
