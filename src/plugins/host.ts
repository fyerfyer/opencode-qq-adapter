import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig, PluginConfig } from "../config/schema.js";
import type { ActiveRun, RunUsage } from "../conversation/types.js";
import type { GroupMode } from "../domain/chat.js";
import type { ConversationRecord, RunStatus } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { AuditTrail } from "../observability/audit.js";
import type { MessageSender } from "../qq/sender.js";
import { type LoadedPluginModule, loadPluginModule, PluginLoadError } from "./manifest.js";
import { PluginMessageService } from "./messages.js";
import type {
  PluginChat,
  PluginCommandContext,
  PluginCommandDefinition,
  PluginConfigReloadContext,
  PluginContext,
  PluginConversation,
  PluginDefinition,
  PluginDisposer,
  PluginEventMap,
  PluginHooksDefinition,
  PluginLogger,
  PluginManifest,
  PluginMessage,
  PluginPromptContext,
  PluginPromptPatch,
  PluginRole,
  PluginRunContext,
  PluginRunStatus,
} from "./sdk.js";
import { PluginDataStorage } from "./storage.js";

const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HOOK_TIMEOUT_MS = 2_000;
const EVENT_TIMEOUT_MS = 2_000;
const LIFECYCLE_TIMEOUT_MS = 5_000;
const ROLES: readonly PluginRole[] = ["owner", "admin", "member"];
const CHAT_TYPES = ["private", "group"] as const;

export type PluginRuntimeStatus = "disabled" | "loaded" | "failed" | "stopped";

export interface PluginConversationSource {
  getConversation(chatKey: string): ConversationRecord | null;
}

export interface PluginHostOptions {
  config: AppConfig;
  logger: Logger;
  audit: AuditTrail;
  sender: MessageSender;
  conversations: PluginConversationSource;
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

interface RegisteredCommand {
  definition: PluginCommandDefinition;
  names: string[];
}

interface RegisteredHook {
  definition: PluginHooksDefinition;
}

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
  dataDir: string;
  commands: Map<string, RegisteredCommand>;
  hooks: RegisteredHook[];
  events: EventSubscription[];
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
  readonly #reserved: Set<string>;
  readonly #coreVersion: string;
  readonly #now: () => number;
  readonly #pluginsDir: string;
  readonly #instances = new Map<string, PluginInstance>();
  #started = false;

  constructor(options: PluginHostOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#sender = options.sender;
    this.#conversations = options.conversations;
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

  async beforePrompt(message: IncomingMessage, projectId: string): Promise<PluginPromptResult> {
    const hooks = this.#loadedHooks("beforePrompt");
    if (hooks.length === 0) {
      return { text: message.text, modified: false, plugins: [] };
    }

    const base: PluginPromptContext = {
      message: toPluginMessage(message),
      projectId,
      conversation: this.#conversationSnapshot(message.chat.chatKey),
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
      projectId: active.record.projectId,
      workspaceId: active.workspaceId,
      sessionId: active.record.sessionId,
      status: status as PluginRunStatus,
      usage: usage === null ? null : { cost: usage.cost, tokens: { ...usage.tokens } },
      error,
      durationMs: Math.max(0, this.#now() - active.record.startedAt),
      promptText: active.message.text,
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
      dataDir: join(this.#pluginsDir, id),
      commands: new Map(),
      hooks: [],
      events: [],
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
      dataDir: join(this.#pluginsDir, id),
      commands: new Map(),
      hooks: [],
      events: [],
      disposers: [],
      loadedAt: null,
    };

    try {
      const loaded = await loadPluginModule(spec, id, this.#coreVersion);
      instance.manifest = loaded.manifest;
      instance.definition = loaded.definition;
      await mkdir(instance.dataDir, { recursive: true, mode: 0o700 });
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
    };
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

function sameSpec(left: PluginConfig, right: PluginConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
