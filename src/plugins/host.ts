import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "pino";
import type { AppConfig, PluginConfig } from "../config/schema.js";
import type { ResolvedReplyPlan, ResolvedReplySegment } from "../conversation/reply-plan.js";
import type { ActiveRun, RunUsage } from "../conversation/types.js";
import type { GroupMode } from "../domain/chat.js";
import type { ConversationRecord, RunStatus } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { AuditTrail } from "../observability/audit.js";
import type { AgentMessage, AgentPort } from "../ports/agent.js";
import type { MessageSender } from "../qq/sender.js";
import { type LoadedPluginModule, loadPluginModule, PluginLoadError } from "./manifest.js";
import { PluginMessageService, readPluginImage } from "./messages.js";
import type {
  PluginAdminActor,
  PluginAdminHandler,
  PluginAdminMethod,
  PluginAdminPage,
  PluginAdminResult,
  PluginAgentCompletion,
  PluginAgentResult,
  PluginChat,
  PluginCommandContext,
  PluginCommandDefinition,
  PluginConfigReloadContext,
  PluginContext,
  PluginConversation,
  PluginConversationProfile,
  PluginDefinition,
  PluginDisposer,
  PluginEventMap,
  PluginHooksDefinition,
  PluginLogger,
  PluginManifest,
  PluginMessage,
  PluginProfileContext,
  PluginPromptContext,
  PluginPromptPatch,
  PluginReplyContext,
  PluginRole,
  PluginRunContext,
  PluginRunStatus,
  PluginSessionMutationResult,
} from "./sdk.js";
import { PluginDataStorage } from "./storage.js";
import {
  isPathInside,
  normalizeUiRelativePath,
  pluginUiCacheControl,
  pluginUiContentType,
} from "./ui-path.js";

const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HOOK_TIMEOUT_MS = 2_000;
const REPLY_HOOK_TIMEOUT_MS = 4_000;
const EVENT_TIMEOUT_MS = 2_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;
const ADMIN_TIMEOUT_MS = 120_000;
const UTILITY_TIMEOUT_MS = 90_000;
const UTILITY_MIN_TIMEOUT_MS = 5_000;
const UTILITY_MAX_TIMEOUT_MS = 300_000;
const UTILITY_MAX_PENDING = 3;
const UTILITY_PROMPT_MAX_CHARS = 50_000;
const DENY_ALL_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" as const }];
const ROLES: readonly PluginRole[] = ["owner", "admin", "member"];
const CHAT_TYPES = ["private", "group"] as const;

export type PluginRuntimeStatus = "disabled" | "loaded" | "failed" | "stopped";

export interface PluginConversationSource {
  getConversation(chatKey: string): ConversationRecord | null;
}

/** Guarded conversation mutations implemented by the core. */
export interface PluginSessionActions {
  setProject(input: {
    chatKey: string;
    projectId: string;
    actorQq: number;
    groupId?: number;
  }): PluginSessionMutationResult;
  reset(input: { chatKey: string; actorQq: number }): PluginSessionMutationResult;
}

export interface PluginHostOptions {
  config: AppConfig;
  logger: Logger;
  audit: AuditTrail;
  sender: MessageSender;
  conversations: PluginConversationSource;
  /** Optional; plugins receive a no-op when the bridge does not provide it. */
  sessionActions?: PluginSessionActions;
  /** Optional; enables `context.agent.complete()` for background plugin work. */
  agent?: AgentPort;
  /** Built-in command names that plugins may not shadow. */
  reservedCommands: Iterable<string>;
  coreVersion: string;
  now?: () => number;
}

export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description: string | null;
  status: PluginRuntimeStatus;
  error: string | null;
  capabilities: string[];
  commands: string[];
  source: string;
  loadedAt: number | null;
  admin: {
    routes: number;
    pages: PluginAdminPage[];
  };
}

export interface PluginHostStatus {
  enabled: boolean;
  total: number;
  loaded: number;
  failed: number;
  plugins: PluginStatus[];
  message: string;
}

export interface PluginReloadReport {
  loaded: number;
  failed: number;
  removed: number;
}

export interface PluginUiPageInfo {
  page: PluginAdminPage;
  /** Normalized HTML entry relative to the UI root. */
  entry: string;
  /** Absolute UI root; internal to the host, never sent to the browser. */
  root: string;
}

export interface PluginUiAssetInfo {
  path: string;
  contentType: string;
  cacheControl: string;
}

interface RegisteredCommand {
  definition: PluginCommandDefinition;
  names: string[];
}

interface RegisteredHook {
  definition: PluginHooksDefinition;
}

interface RegisteredAdminRoute {
  method: PluginAdminMethod;
  pattern: string;
  segments: AdminPathSegment[];
  handler: PluginAdminHandler;
  order: number;
}

type AdminPathSegment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard" };

interface EventSubscription {
  type: keyof PluginEventMap;
  handler: (event: unknown) => void | Promise<void>;
}

interface PluginInstance {
  id: string;
  order: number;
  spec: PluginConfig;
  status: PluginRuntimeStatus;
  error: string | null;
  manifest: PluginManifest | null;
  definition: PluginDefinition<unknown> | null;
  context: PluginContext<unknown> | null;
  packageRoot: string | null;
  dataDir: string;
  commands: Map<string, RegisteredCommand>;
  hooks: RegisteredHook[];
  events: EventSubscription[];
  adminRoutes: RegisteredAdminRoute[];
  adminPages: PluginAdminPage[];
  disposers: PluginDisposer[];
  loadedAt: number | null;
}

export interface PluginCommandInput {
  name: string;
  message: IncomingMessage;
  args: string[];
  rawArgs: string;
  actor: PluginRole;
  groupMode: GroupMode | null;
}

export interface PluginPromptResult {
  text: string;
  modified: boolean;
  plugins: string[];
}

export interface PluginProfileResult {
  profile: PluginConversationProfile | null;
  plugins: string[];
}

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
  readonly #agent: AgentPort | undefined;
  readonly #reserved: Set<string>;
  readonly #coreVersion: string;
  readonly #now: () => number;
  readonly #pluginsDir: string;
  readonly #instances = new Map<string, PluginInstance>();
  readonly #utilityChains = new Map<string, Promise<unknown>>();
  readonly #utilityAbort = new Map<string, AbortController>();
  readonly #utilityPending = new Map<string, number>();
  #started = false;

  constructor(options: PluginHostOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#sender = options.sender;
    this.#conversations = options.conversations;
    this.#sessionActions = options.sessionActions;
    this.#agent = options.agent;
    this.#reserved = new Set([...options.reservedCommands].map((name) => name.toLowerCase()));
    this.#coreVersion = options.coreVersion;
    this.#now = options.now ?? Date.now;
    this.#pluginsDir = resolve(this.#config.storage.plugins_dir);
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
    const method = request.method.toUpperCase() as PluginAdminMethod;
    const normalized = normalizeAdminPath(path);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const candidates = instance.adminRoutes
      .filter((route) => route.method === method)
      .map((route) => ({ route, params: matchAdminPath(route.segments, segments) }))
      .filter(
        (item): item is { route: RegisteredAdminRoute; params: Record<string, string> } =>
          item.params !== null,
      )
      .sort(
        (left, right) =>
          adminSpecificity(right.route) - adminSpecificity(left.route) ||
          left.route.order - right.route.order,
      );
    const selected = candidates[0];
    if (selected === undefined) return null;

    const query = new URL(request.url).searchParams;
    const result = await withTimeout(
      Promise.resolve(
        selected.route.handler({
          request,
          method,
          path: normalized,
          params: selected.params,
          query,
          actor,
        }),
      ),
      ADMIN_TIMEOUT_MS,
      `admin route ${method} ${selected.route.pattern} of ${pluginId}`,
    );
    return result;
  }

  /**
   * Resolve an iframe admin page and its HTML entry. The returned root is
   * internal; callers must never expose it to the browser.
   */
  adminUiPage(pluginId: string, pageId?: string): PluginUiPageInfo | null {
    const instance = this.#instances.get(pluginId);
    if (instance === undefined || instance.status !== "loaded") return null;
    const manifest = instance.manifest;
    if (manifest === null || instance.packageRoot === null) return null;
    const pages = instance.adminPages.filter((page) => page.kind === "iframe");
    const page = pageId === undefined ? pages[0] : pages.find((item) => item.id === pageId);
    if (page === undefined) return null;
    const entry = page.entry ?? manifest.ui?.entry;
    if (entry === undefined) return null;
    let normalizedEntry: string;
    try {
      normalizedEntry = normalizeUiRelativePath(entry, "page entry");
    } catch {
      return null;
    }
    const rootName = manifest.ui?.root ?? "ui";
    let root: string;
    try {
      root = resolve(instance.packageRoot, normalizeUiRelativePath(rootName, "ui.root"));
    } catch {
      return null;
    }
    return { page, entry: normalizedEntry, root };
  }

  /** Resolve a static UI asset, following symlinks only when they stay in root. */
  async resolveAdminUiAsset(
    pluginId: string,
    assetPath: string,
  ): Promise<PluginUiAssetInfo | null> {
    const instance = this.#instances.get(pluginId);
    if (instance === undefined || instance.status !== "loaded" || instance.packageRoot === null) {
      return null;
    }
    let relativePath: string;
    try {
      relativePath = normalizeUiRelativePath(assetPath, "UI asset path");
    } catch {
      return null;
    }
    const rootName = instance.manifest?.ui?.root ?? "ui";
    let root: string;
    try {
      root = resolve(instance.packageRoot, normalizeUiRelativePath(rootName, "ui.root"));
    } catch {
      return null;
    }
    const rootReal = await realpath(root).catch(() => null);
    if (rootReal === null) return null;
    const candidate = resolve(root, relativePath);
    if (!isPathInside(root, candidate)) return null;
    const info = await stat(candidate).catch(() => null);
    if (info === null || !info.isFile()) return null;
    const real = await realpath(candidate).catch(() => null);
    if (real === null || !isPathInside(rootReal, real)) return null;
    return {
      path: real,
      contentType: pluginUiContentType(relativePath),
      cacheControl: pluginUiCacheControl(relativePath),
    };
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
        const profile = await this.#normalizeProfile(raw, projectId, instance.id);
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
        const plan = await this.#normalizeReplyPlan(instance, active, raw);
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

  async #normalizeReplyPlan(
    instance: PluginInstance,
    active: ActiveRun,
    value: unknown,
  ): Promise<ResolvedReplyPlan | null> {
    if (!isRecord(value)) return null;
    const replyText = normalizeReplyText(value.replyText);
    if (value.suppress === true) {
      return {
        segments: [],
        suppress: true,
        ...(replyText !== undefined ? { replyText } : {}),
      };
    }
    if (!Array.isArray(value.segments)) return null;
    if (value.segments.length === 0 || value.segments.length > 8) return null;

    const resolved: ResolvedReplySegment[] = [];
    const maxImages = Math.max(0, Math.floor(this.#config.qq.max_reply_images));
    let images = 0;
    let chars = 0;
    for (const item of value.segments) {
      if (!isRecord(item)) continue;
      const delayMs =
        typeof item.delayMs === "number" && Number.isFinite(item.delayMs)
          ? Math.max(0, Math.min(5000, Math.floor(item.delayMs)))
          : 0;
      if (typeof item.text === "string") {
        const text = item.text.trim();
        if (text.length === 0) continue;
        chars += text.length;
        if (chars > 8000) return null;
        resolved.push({ kind: "text", text, ...(delayMs > 0 ? { delayMs } : {}) });
        continue;
      }
      if (!isRecord(item.image)) continue;
      const path = typeof item.image.path === "string" ? item.image.path.trim() : "";
      if (path.length === 0) continue;
      if (images >= maxImages) {
        this.#logger.warn(
          { pluginId: instance.id, runId: active.record.id, path },
          "Plugin reply exceeds the image limit; skipping image segment",
        );
        continue;
      }
      try {
        const image = await readPluginImage({
          dataDir: instance.dataDir,
          path,
          maxBytes: this.#config.security.max_outbound_image_bytes,
          imagesEnabled: this.#config.features.images,
        });
        images += 1;
        const caption =
          typeof item.image.caption === "string" ? item.image.caption.trim().slice(0, 500) : "";
        resolved.push({
          kind: "image",
          dataUri: image.dataUri,
          bytes: image.bytes,
          mime: image.mime,
          pluginId: instance.id,
          sourcePath: image.path,
          ...(caption.length > 0 ? { caption } : {}),
          ...(delayMs > 0 ? { delayMs } : {}),
        });
        this.#audit.record({
          ts: this.#now(),
          actorQq: active.message.userId,
          chatKey: active.message.chat.chatKey,
          projectId: active.record.projectId,
          workspaceId: active.workspaceId,
          action: "plugin.reply_image",
          detail: {
            pluginId: instance.id,
            runId: active.record.id,
            path: image.path,
            bytes: image.bytes,
            mime: image.mime,
          },
        });
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id, runId: active.record.id, path },
          "Plugin reply image rejected; skipping image segment",
        );
      }
    }

    if (resolved.length === 0) {
      this.#logger.warn(
        { pluginId: instance.id, runId: active.record.id },
        "Plugin reply plan had no valid segments; suppressing the reply",
      );
      return {
        segments: [],
        suppress: true,
        ...(replyText !== undefined ? { replyText } : {}),
      };
    }
    return {
      segments: resolved,
      ...(replyText !== undefined ? { replyText } : {}),
    };
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
      this.#utilityAbort.set(id, new AbortController());
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
    this.#utilityAbort.get(instance.id)?.abort();
    const utilityChain = this.#utilityChains.get(instance.id);
    if (utilityChain !== undefined) {
      await withTimeout(
        utilityChain,
        LIFECYCLE_TIMEOUT_MS,
        `utility runs of ${instance.id} during dispose`,
      ).catch(() => undefined);
    }
    this.#utilityChains.delete(instance.id);
    this.#utilityAbort.delete(instance.id);
    this.#utilityPending.delete(instance.id);

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
    const definition = instance.definition;
    const manifest = instance.manifest;
    if (definition === null || manifest === null) {
      throw new Error("plugin context requested before manifest was loaded");
    }
    const logger = this.#pluginLogger(instance);
    const messages = new PluginMessageService({
      config: this.#config,
      sender: this.#sender,
      logger,
      dataDir: instance.dataDir,
    }).createApi();
    const storage = new PluginDataStorage(instance.dataDir);

    const commands = {
      register: (command: PluginCommandDefinition): (() => void) => {
        requireCapability(instance, "commands");
        const names = validateCommand(command);
        if (names.some((name) => this.#reserved.has(name))) {
          throw new Error(
            `command '${names.find((name) => this.#reserved.has(name))}' is reserved by the core`,
          );
        }
        for (const registered of instance.commands.values()) {
          for (const name of names) {
            if (registered.names.includes(name)) {
              throw new Error(`duplicate command '${name}' in plugin ${instance.id}`);
            }
          }
        }
        for (const other of this.#sorted()) {
          if (other.id === instance.id || other.status !== "loaded") continue;
          for (const registered of other.commands.values()) {
            for (const name of names) {
              if (registered.names.includes(name)) {
                throw new Error(`command '${name}' is already registered by plugin ${other.id}`);
              }
            }
          }
        }
        const registered: RegisteredCommand = { definition: command, names };
        instance.commands.set(command.name, registered);
        return () => {
          if (instance.commands.get(command.name) === registered) {
            instance.commands.delete(command.name);
          }
        };
      },
      unregister: (name: string): void => {
        const normalized = name.toLowerCase();
        for (const [key, registered] of instance.commands) {
          if (registered.names.includes(normalized)) instance.commands.delete(key);
        }
      },
    };

    const hooks = {
      register: (definitionHooks: PluginHooksDefinition): (() => void) => {
        requireCapability(instance, "hooks");
        const registered: RegisteredHook = { definition: definitionHooks };
        instance.hooks.push(registered);
        return () => {
          const index = instance.hooks.indexOf(registered);
          if (index >= 0) instance.hooks.splice(index, 1);
        };
      },
    };

    const events = {
      on: <K extends keyof PluginEventMap>(
        type: K,
        handler: (event: PluginEventMap[K]) => void | Promise<void>,
      ): (() => void) => {
        requireCapability(instance, "events");
        if (typeof handler !== "function") throw new Error("event handler must be a function");
        const subscription: EventSubscription = {
          type,
          handler: handler as (event: unknown) => void | Promise<void>,
        };
        instance.events.push(subscription);
        return () => {
          const index = instance.events.indexOf(subscription);
          if (index >= 0) instance.events.splice(index, 1);
        };
      },
    };

    const sessions = {
      get: (chatKey: string) => this.#conversationSnapshot(chatKey),
      setProject: (
        chatKey: string,
        projectId: string,
        actor: { qq: number; role: PluginRole },
      ): PluginSessionMutationResult => this.#setProject(chatKey, projectId, actor.qq),
      reset: (
        chatKey: string,
        actor: { qq: number; role: PluginRole },
      ): PluginSessionMutationResult => this.#resetSession(chatKey, actor.qq),
    };

    const admin = {
      route: (
        method: PluginAdminMethod,
        routePath: string,
        handler: PluginAdminHandler,
      ): (() => void) => {
        requireCapability(instance, "admin");
        const normalizedMethod = normalizeAdminMethod(method);
        const normalizedPath = normalizeAdminPath(routePath);
        if (normalizedPath === "/") {
          throw new Error("admin route path must not be the plugin root");
        }
        if (typeof handler !== "function") {
          throw new Error("admin route handler must be a function");
        }
        if (
          instance.adminRoutes.some(
            (route) => route.method === normalizedMethod && route.pattern === normalizedPath,
          )
        ) {
          throw new Error(`duplicate admin route ${normalizedMethod} ${normalizedPath}`);
        }
        const route: RegisteredAdminRoute = {
          method: normalizedMethod,
          pattern: normalizedPath,
          segments: compileAdminPath(normalizedPath),
          handler,
          order: instance.adminRoutes.length,
        };
        instance.adminRoutes.push(route);
        return () => {
          const index = instance.adminRoutes.indexOf(route);
          if (index >= 0) instance.adminRoutes.splice(index, 1);
        };
      },
      page: (page: PluginAdminPage): (() => void) => {
        requireCapability(instance, "admin");
        const normalized = normalizeAdminPage(page, instance.id, manifest);
        if (instance.adminPages.some((item) => item.id === normalized.id)) {
          throw new Error(`duplicate admin page '${normalized.id}'`);
        }
        instance.adminPages.push(normalized);
        return () => {
          const index = instance.adminPages.indexOf(normalized);
          if (index >= 0) instance.adminPages.splice(index, 1);
        };
      },
    };

    return {
      manifest,
      config: options,
      dataDir: instance.dataDir,
      logger,
      storage,
      commands,
      hooks,
      messages,
      sessions,
      events,
      agent: {
        complete: (input: PluginAgentCompletion) => this.#completeUtility(instance, input),
      },
      admin,
    };
  }

  async #completeUtility(
    instance: PluginInstance,
    input: PluginAgentCompletion,
  ): Promise<PluginAgentResult> {
    requireCapability(instance, "agent");
    if (this.#agent === undefined) {
      throw new Error("utility agent is not available in this bridge");
    }
    const request = normalizeUtilityInput(input);
    const pending = (this.#utilityPending.get(instance.id) ?? 0) + 1;
    if (pending > UTILITY_MAX_PENDING) {
      throw new Error(
        `plugin ${instance.id} already has ${UTILITY_MAX_PENDING} utility runs pending`,
      );
    }
    this.#utilityPending.set(instance.id, pending);

    const previous = this.#utilityChains.get(instance.id) ?? Promise.resolve();
    const task = previous.then(
      () => this.#runUtility(instance, request),
      () => this.#runUtility(instance, request),
    );
    let tail: Promise<void>;
    tail = task.then(
      () => {
        this.#finishUtilityPending(instance.id, tail);
      },
      () => {
        this.#finishUtilityPending(instance.id, tail);
      },
    );
    this.#utilityChains.set(instance.id, tail);
    return task;
  }

  async #runUtility(
    instance: PluginInstance,
    request: NormalizedUtilityInput,
  ): Promise<PluginAgentResult> {
    const agent = this.#agent;
    if (agent === undefined) throw new Error("utility agent is not available in this bridge");
    const startedAt = this.#now();
    const controller = new AbortController();
    const instanceSignal = this.#utilityAbort.get(instance.id)?.signal;
    const abortFromInstance = (): void => controller.abort();
    if (instanceSignal?.aborted === true) {
      controller.abort();
    } else {
      instanceSignal?.addEventListener("abort", abortFromInstance, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();

    let sessionId: string | null = null;
    let usage: PluginAgentResult["usage"] = null;
    let errorMessage: string | null = null;
    try {
      const session = await agent.createSession({
        directory: instance.dataDir,
        title: `plugin:${instance.id}:${request.label}`.slice(0, 120),
        ...(request.agent !== null ? { agent: request.agent } : {}),
        ...(request.model !== null ? { model: request.model } : {}),
        permissions: DENY_ALL_PERMISSIONS,
      });
      sessionId = session.id;
      await withTimeout(
        agent.prompt({ sessionId, text: request.prompt }),
        10_000,
        "utility prompt admission",
      );
      await withTimeout(
        agent.waitForCompletion(sessionId, controller.signal),
        request.timeoutMs + 1_000,
        "utility agent completion",
      );
      const messages = await withTimeout(
        agent.listMessages(sessionId, 20),
        5_000,
        "utility message read",
      );
      const text = messages
        .filter((message) => message.type === "assistant" && message.text.trim().length > 0)
        .sort((left, right) => left.created - right.created)
        .at(-1)
        ?.text.trim();
      if (text === undefined || text.length === 0) {
        throw new Error("utility agent returned no text");
      }
      usage = sumUtilityUsage(messages);
      return { text, sessionId, usage };
    } catch (error) {
      errorMessage = describeError(error);
      if (sessionId !== null && controller.signal.aborted) {
        await agent.interrupt(sessionId).catch(() => undefined);
      }
      if (timedOut) {
        throw new Error(`utility agent timed out after ${request.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      instanceSignal?.removeEventListener("abort", abortFromInstance);
      if (sessionId !== null) {
        await withTimeout(agent.deleteSession(sessionId), 5_000, "utility session delete").catch(
          (error) => {
            this.#logger.warn(
              { err: error, pluginId: instance.id, sessionId },
              "Failed to delete utility session",
            );
          },
        );
      }
      this.#audit.record({
        ts: this.#now(),
        actorQq: request.actorQq,
        chatKey: request.chatKey,
        projectId: null,
        workspaceId: null,
        action: "plugin.agent",
        detail: {
          pluginId: instance.id,
          label: request.label,
          agent: request.agent,
          model: request.model,
          sessionId,
          ok: errorMessage === null,
          ...(errorMessage !== null ? { error: errorMessage } : {}),
          durationMs: Math.max(0, this.#now() - startedAt),
          costUsd: usage?.cost ?? 0,
          inputTokens: usage?.tokens.input ?? 0,
          outputTokens: usage?.tokens.output ?? 0,
        },
      });
    }
  }

  #finishUtilityPending(pluginId: string, tail: Promise<void>): void {
    const pending = Math.max(0, (this.#utilityPending.get(pluginId) ?? 1) - 1);
    if (pending === 0) this.#utilityPending.delete(pluginId);
    else this.#utilityPending.set(pluginId, pending);
    if (this.#utilityChains.get(pluginId) === tail) {
      this.#utilityChains.delete(pluginId);
    }
  }

  async #normalizeProfile(
    raw: Record<string, unknown>,
    projectId: string,
    pluginId: string,
  ): Promise<PluginConversationProfile | null> {
    const project = this.#config.projects[projectId];
    if (project === undefined) return null;

    const workspace = raw.workspace;
    if (workspace !== undefined && workspace !== "inherit" && workspace !== "none") {
      this.#logger.warn(
        { pluginId, projectId, workspace },
        "Plugin profile has an invalid workspace mode; ignoring",
      );
      return null;
    }

    const directory =
      typeof raw.directory === "string" && raw.directory.trim().length > 0
        ? raw.directory.trim()
        : undefined;
    if ((directory !== undefined || workspace === "none") && project.workspace !== "none") {
      this.#logger.warn(
        { pluginId, projectId },
        "Plugin profile requested a lock-free directory for a normal workspace project; ignoring",
      );
      return null;
    }

    let resolvedDirectory: string | undefined;
    if (directory !== undefined) {
      try {
        const root = await realpath(resolve(project.path));
        const target = await realpath(resolve(directory));
        const rel = relative(root, target);
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          this.#logger.warn(
            { pluginId, projectId, directory: target },
            "Plugin profile directory escapes the project root; ignoring",
          );
          return null;
        }
        resolvedDirectory = target;
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId, projectId, directory },
          "Plugin profile directory is not accessible; ignoring",
        );
        return null;
      }
    }

    const agent =
      typeof raw.agent === "string" && raw.agent.trim().length > 0 && raw.agent.length <= 200
        ? raw.agent.trim()
        : undefined;
    const model =
      typeof raw.model === "string" && raw.model.trim().length > 0 && raw.model.length <= 200
        ? raw.model.trim()
        : undefined;

    return {
      ...(resolvedDirectory !== undefined ? { directory: resolvedDirectory } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(workspace === "none" || project.workspace === "none"
        ? { workspace: "none" as const }
        : {}),
    };
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
      loadedAt: instance.loadedAt,
      admin: {
        routes: instance.adminRoutes.length,
        pages: [...instance.adminPages],
      },
    };
  }
}

function parseOptions(loaded: LoadedPluginModule, options: Record<string, unknown>): unknown {
  if (loaded.definition.options === undefined) return options;
  try {
    return loaded.definition.options.parse(options);
  } catch (error) {
    throw new Error(
      `invalid options for plugin ${loaded.manifest.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requireCapability(instance: PluginInstance, capability: string): void {
  const capabilities: readonly string[] = instance.manifest?.capabilities ?? [];
  if (!capabilities.includes(capability)) {
    throw new Error(
      `plugin ${instance.id} must declare capability '${capability}' in its manifest`,
    );
  }
}

function validateCommand(command: PluginCommandDefinition): string[] {
  if (!isRecord(command)) throw new Error("command definition must be an object");
  if (typeof command.name !== "string" || !COMMAND_NAME.test(command.name)) {
    throw new Error("command name must match /^[a-z][a-z0-9_-]{0,31}$/");
  }
  if (typeof command.handler !== "function") {
    throw new Error(`command '${command.name}' must provide a handler function`);
  }
  const aliases = command.aliases ?? [];
  if (!Array.isArray(aliases))
    throw new Error(`command '${command.name}' aliases must be an array`);
  const names = [command.name, ...aliases].map((name) => {
    if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
      throw new Error(`invalid command/alias name: ${String(name)}`);
    }
    return name.toLowerCase();
  });
  if (new Set(names).size !== names.length) {
    throw new Error(`command '${command.name}' has duplicate names/aliases`);
  }
  if (command.roles !== undefined) {
    if (!Array.isArray(command.roles) || command.roles.length === 0) {
      throw new Error(`command '${command.name}' roles must be a non-empty array`);
    }
    for (const role of command.roles) {
      if (!ROLES.includes(role)) throw new Error(`invalid role: ${String(role)}`);
    }
  }
  if (command.chats !== undefined) {
    if (!Array.isArray(command.chats) || command.chats.length === 0) {
      throw new Error(`command '${command.name}' chats must be a non-empty array`);
    }
    for (const type of command.chats) {
      if (!CHAT_TYPES.includes(type)) throw new Error(`invalid chat type: ${String(type)}`);
    }
  }
  return names;
}

function normalizeReplyText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= 8000 ? text : null;
}

function groupIdFromChatKey(chatKey: string): number | undefined {
  const match = /^group:(\d+)/.exec(chatKey);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function isPromptPatch(value: unknown): value is PluginPromptPatch {
  return isRecord(value);
}

function toPluginChat(chat: {
  type: "private" | "group";
  userId: number;
  groupId?: number;
  chatKey: string;
}): PluginChat {
  return {
    type: chat.type,
    userId: chat.userId,
    ...(chat.groupId !== undefined ? { groupId: chat.groupId } : {}),
    chatKey: chat.chatKey,
  };
}

function toPluginMessage(message: IncomingMessage): PluginMessage {
  return {
    id: message.id,
    chat: toPluginChat(message.chat),
    userId: message.userId,
    senderName: message.senderName,
    text: message.text,
    images: message.images.map((image) => ({ ...image })),
    ...(message.replyToId !== undefined ? { replyToId: message.replyToId } : {}),
    mentionsBot: message.mentionsBot,
    receivedAt: message.receivedAt,
  };
}

interface NormalizedUtilityInput {
  prompt: string;
  agent: string | null;
  model: string | null;
  timeoutMs: number;
  label: string;
  chatKey: string | null;
  actorQq: number | null;
}

function normalizeUtilityInput(input: PluginAgentCompletion): NormalizedUtilityInput {
  if (!isRecord(input)) throw new Error("utility input must be an object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length === 0) throw new Error("utility prompt must not be empty");
  if (prompt.length > UTILITY_PROMPT_MAX_CHARS) {
    throw new Error(`utility prompt exceeds ${UTILITY_PROMPT_MAX_CHARS} characters`);
  }
  const agent = optionalPattern(input.agent, /^[A-Za-z0-9._/-]{1,80}$/, "utility agent");
  const model = optionalPattern(input.model, /^[A-Za-z0-9._/:#-]{1,160}$/, "utility model");
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.min(
          UTILITY_MAX_TIMEOUT_MS,
          Math.max(UTILITY_MIN_TIMEOUT_MS, Math.floor(input.timeoutMs)),
        )
      : UTILITY_TIMEOUT_MS;
  const label =
    (typeof input.label === "string" ? input.label : "utility")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 48) || "utility";
  const chatKey =
    typeof input.chatKey === "string" && input.chatKey.trim().length > 0
      ? input.chatKey.trim().slice(0, 160)
      : null;
  const actorQq =
    typeof input.actorQq === "number" && Number.isSafeInteger(input.actorQq) && input.actorQq > 0
      ? input.actorQq
      : null;
  return { prompt, agent, model, timeoutMs, label, chatKey, actorQq };
}

function optionalPattern(value: unknown, pattern: RegExp, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!pattern.test(trimmed)) throw new Error(`${label} contains invalid characters`);
  return trimmed;
}

function sumUtilityUsage(messages: AgentMessage[]): PluginAgentResult["usage"] {
  let cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let found = false;
  for (const message of messages) {
    if (message.cost !== null) {
      cost += message.cost;
      found = true;
    }
    if (message.tokens !== null) {
      tokens.input += message.tokens.input;
      tokens.output += message.tokens.output;
      tokens.reasoning += message.tokens.reasoning;
      tokens.cacheRead += message.tokens.cacheRead;
      tokens.cacheWrite += message.tokens.cacheWrite;
      found = true;
    }
  }
  return found ? { cost, tokens } : null;
}

function sameSpec(left: PluginConfig, right: PluginConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeAdminMethod(method: PluginAdminMethod): PluginAdminMethod {
  const normalized = String(method).toUpperCase();
  if (
    normalized !== "GET" &&
    normalized !== "POST" &&
    normalized !== "PUT" &&
    normalized !== "PATCH" &&
    normalized !== "DELETE"
  ) {
    throw new Error(`unsupported admin method: ${String(method)}`);
  }
  return normalized;
}

function normalizeAdminPath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("admin route path must be a non-empty string");
  }
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`admin route path must not contain '.' or '..': ${path}`);
  }
  return normalized;
}

function compileAdminPath(path: string): AdminPathSegment[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment): AdminPathSegment => {
      if (segment === "*") return { kind: "wildcard" };
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
          throw new Error(`invalid admin route parameter: ${segment}`);
        }
        return { kind: "param", name };
      }
      if (segment.includes(":") || segment.includes("*")) {
        throw new Error(`admin route parameters must occupy a full segment: ${segment}`);
      }
      return { kind: "static", value: segment };
    });
}

function matchAdminPath(
  pattern: AdminPathSegment[],
  segments: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  let index = 0;
  for (const part of pattern) {
    if (part.kind === "wildcard") {
      const rest = segments.slice(index);
      if (rest.length === 0) return null;
      params["*"] = rest.map(decodeAdminSegment).join("/");
      return params;
    }
    const value = segments[index];
    if (value === undefined) return null;
    if (part.kind === "static") {
      if (value !== part.value) return null;
    } else {
      const decoded = decodeAdminSegment(value);
      if (decoded.length === 0 || decoded.includes("/")) return null;
      params[part.name] = decoded;
    }
    index += 1;
  }
  return index === segments.length ? params : null;
}

function decodeAdminSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function adminSpecificity(route: RegisteredAdminRoute): number {
  let score = 0;
  for (const segment of route.segments) {
    if (segment.kind === "static") score += 100;
    else if (segment.kind === "param") score += 10;
  }
  return score + route.segments.length;
}

function normalizeAdminPage(
  page: PluginAdminPage,
  pluginId: string,
  manifest: PluginManifest,
): PluginAdminPage {
  if (!isRecord(page)) throw new Error("admin page must be an object");
  const id = typeof page.id === "string" ? page.id.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("admin page id must be lowercase letters, digits or dashes");
  }
  const title = typeof page.title === "string" ? page.title.trim() : "";
  if (title.length === 0 || title.length > 120) {
    throw new Error("admin page title must be 1-120 characters");
  }
  const kind = page.kind ?? "native";
  if (kind !== "native" && kind !== "iframe") {
    throw new Error("admin page kind must be 'native' or 'iframe'");
  }
  const description =
    typeof page.description === "string" && page.description.trim().length > 0
      ? page.description.trim().slice(0, 500)
      : undefined;

  if (kind === "iframe") {
    if (manifest.ui === undefined && page.entry === undefined) {
      throw new Error(`iframe admin page '${id}' requires manifest.ui or a page entry`);
    }
    const entry = page.entry ?? manifest.ui?.entry;
    if (entry === undefined) {
      throw new Error(`iframe admin page '${id}' requires an HTML entry`);
    }
    let normalizedEntry: string;
    try {
      normalizedEntry = normalizeUiRelativePath(entry, "page entry");
    } catch (error) {
      throw new Error(
        `invalid entry for iframe admin page '${id}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!normalizedEntry.toLowerCase().endsWith(".html")) {
      throw new Error(`iframe admin page '${id}' entry must point to an HTML file`);
    }
    return {
      id,
      title,
      path: `/plugins/${pluginId}/${id}`,
      kind,
      entry: normalizedEntry,
      ...(description !== undefined ? { description } : {}),
    };
  }

  if (page.path === undefined) {
    throw new Error(`native admin page '${id}' requires a path`);
  }
  const path = normalizeAdminPath(page.path);
  if (path === "/admin" || path.startsWith("/admin/")) {
    throw new Error("admin page path must be a core UI route outside /admin");
  }
  return {
    id,
    title,
    path,
    kind,
    ...(description !== undefined ? { description } : {}),
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
