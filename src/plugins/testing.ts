import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginAgent,
  PluginAgentCompletion,
  PluginChat,
  PluginCommandContext,
  PluginCommandDefinition,
  PluginContext,
  PluginConversationProfile,
  PluginDefinition,
  PluginDisposer,
  PluginEventMap,
  PluginFileInput,
  PluginGroupMode,
  PluginHooksDefinition,
  PluginImageInput,
  PluginLogger,
  PluginMessage,
  PluginProfileContext,
  PluginPromptContext,
  PluginPromptPatch,
  PluginReplyContext,
  PluginReplyPlan,
  PluginRole,
  PluginRunContext,
  PluginSendResult,
} from "./sdk.js";
import { PluginDataStorage } from "./storage.js";

export interface HarnessSend {
  kind: "text" | "image" | "file";
  chat: PluginChat;
  text?: string;
  path?: string;
  caption?: string;
  name?: string;
}

export interface PluginHarnessOptions<TOptions = Record<string, unknown>> {
  /** Raw options passed through the plugin's options schema. */
  options?: unknown;
  dataDir?: string;
  logger?: PluginLogger;
  config?: TOptions;
  /** Optional fake for `context.agent.complete`. */
  agent?: PluginAgent;
}

export interface RunCommandOptions {
  message?: Partial<PluginMessage>;
  args?: string[];
  rawArgs?: string;
  groupMode?: PluginGroupMode | null;
  actorRole?: PluginRole;
}

export interface HarnessSessionCall {
  action: "setProject" | "reset";
  chatKey: string;
  projectId?: string;
  actorQq: number;
}

export interface PluginHarness<TOptions = Record<string, unknown>> {
  readonly context: PluginContext<TOptions>;
  readonly commands: Map<string, PluginCommandDefinition>;
  readonly hooks: PluginHooksDefinition[];
  readonly sent: HarnessSend[];
  readonly sessionCalls: HarnessSessionCall[];
  readonly agentCalls: PluginAgentCompletion[];
  runCommand(name: string, options?: RunCommandOptions): Promise<string | undefined>;
  resolveProfile(context: PluginProfileContext): Promise<PluginConversationProfile | null>;
  beforePrompt(context: PluginPromptContext): Promise<PluginPromptPatch | undefined>;
  formatReply(context: PluginReplyContext): Promise<PluginReplyPlan | null>;
  afterRun(context: PluginRunContext): Promise<void>;
  emit<K extends keyof PluginEventMap>(type: K, event: PluginEventMap[K]): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Lightweight plugin test harness for unit tests outside the bridge.
 *
 * It exercises registration, options validation and command/hook code without
 * starting QQ or OpenCode. Media sends are recorded instead of transmitted.
 */
export async function createPluginHarness<TOptions = Record<string, unknown>>(
  definition: PluginDefinition<TOptions>,
  options: PluginHarnessOptions<TOptions> = {},
): Promise<PluginHarness<TOptions>> {
  const ownedDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "qq-plugin-test-")));
  const config = (definition.options?.parse(options.options ?? {}) ??
    options.config ??
    ({} as TOptions)) as TOptions;
  const logger = options.logger ?? silentLogger();
  const commands = new Map<string, PluginCommandDefinition>();
  const hooks: PluginHooksDefinition[] = [];
  const events: Array<{
    type: keyof PluginEventMap;
    handler: (event: unknown) => void | Promise<void>;
  }> = [];
  const sent: HarnessSend[] = [];
  const sessionCalls: HarnessSessionCall[] = [];
  const agentCalls: PluginAgentCompletion[] = [];
  const disposers: PluginDisposer[] = [];

  const agentApi: PluginAgent = {
    async complete(input) {
      agentCalls.push(input);
      if (options.agent === undefined) {
        throw new Error("utility agent is not configured in this harness");
      }
      return options.agent.complete(input);
    },
  };

  const commandsApi = {
    register: (command: PluginCommandDefinition): (() => void) => {
      if (commands.has(command.name)) {
        throw new Error(`duplicate command '${command.name}'`);
      }
      commands.set(command.name, command);
      return () => commands.delete(command.name);
    },
    unregister: (name: string): void => {
      commands.delete(name);
    },
  };

  const hooksApi = {
    register: (registered: PluginHooksDefinition): (() => void) => {
      hooks.push(registered);
      return () => {
        const index = hooks.indexOf(registered);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
  };

  const eventsApi = {
    on: <K extends keyof PluginEventMap>(
      type: K,
      handler: (event: PluginEventMap[K]) => void | Promise<void>,
    ): (() => void) => {
      const subscription = {
        type,
        handler: handler as (event: unknown) => void | Promise<void>,
      };
      events.push(subscription);
      return () => {
        const index = events.indexOf(subscription);
        if (index >= 0) events.splice(index, 1);
      };
    },
  };

  const send = (kind: HarnessSend["kind"], chat: PluginChat, detail: Partial<HarnessSend>) => {
    sent.push({ kind, chat, ...detail });
    return { messageId: `harness-${sent.length}` } satisfies PluginSendResult;
  };

  const messages = {
    reply: (message: PluginMessage, text: string) =>
      Promise.resolve(send("text", message.chat, { text })),
    send: (chat: PluginChat, text: string) => Promise.resolve(send("text", chat, { text })),
    sendImage: (chat: PluginChat, input: PluginImageInput) =>
      Promise.resolve(send("image", chat, { path: input.path, caption: input.caption })),
    sendFile: (chat: PluginChat, input: PluginFileInput) =>
      Promise.resolve(
        send("file", chat, { path: input.path, caption: input.caption, name: input.name }),
      ),
  };

  const context: PluginContext<TOptions> = {
    manifest: {
      id: "test-plugin",
      name: "Test plugin",
      version: "0.0.0",
      apiVersion: 1,
      capabilities: ["commands", "hooks", "messages", "sessions", "events"],
    },
    config,
    dataDir,
    logger,
    storage: new PluginDataStorage(dataDir),
    commands: commandsApi,
    hooks: hooksApi,
    messages,
    sessions: {
      get: () => null,
      setProject: (chatKey, projectId, actor) => {
        sessionCalls.push({ action: "setProject", chatKey, projectId, actorQq: actor.qq });
        return { ok: true };
      },
      reset: (chatKey, actor) => {
        sessionCalls.push({ action: "reset", chatKey, actorQq: actor.qq });
        return { ok: true };
      },
    },
    events: eventsApi,
    agent: agentApi,
  };

  const disposer = await definition.setup(context);
  if (typeof disposer === "function") disposers.push(disposer);
  await definition.start?.(context);

  return {
    context,
    commands,
    hooks,
    sent,
    sessionCalls,
    agentCalls,
    async runCommand(name: string, overrides: RunCommandOptions = {}): Promise<string | undefined> {
      const command = findCommand(commands, name);
      if (command === undefined) throw new Error(`unknown harness command: ${name}`);
      const message = makeMessage(overrides.message);
      const args = overrides.args ?? [];
      const commandContext: PluginCommandContext = {
        message,
        args,
        rawArgs: overrides.rawArgs ?? args.join(" "),
        actor: { qq: message.userId, role: overrides.actorRole ?? "owner" },
        groupMode: overrides.groupMode ?? null,
        conversation: null,
        logger,
        reply: (text) => messages.reply(message, text),
        sendImage: (input) => messages.sendImage(message.chat, input),
        sendFile: (input) => messages.sendFile(message.chat, input),
      };
      const result = await command.handler(commandContext);
      if (typeof result === "string" && result.trim().length > 0) {
        await commandContext.reply(result);
      }
      return typeof result === "string" ? result : undefined;
    },
    async resolveProfile(
      profileContext: PluginProfileContext,
    ): Promise<PluginConversationProfile | null> {
      for (const hook of hooks) {
        const profile = await hook.resolveConversationProfile?.(profileContext);
        if (profile !== undefined && profile !== null) return profile;
      }
      return null;
    },
    async beforePrompt(promptContext: PluginPromptContext): Promise<PluginPromptPatch | undefined> {
      let prepend = "";
      let append = "";
      for (const hook of hooks) {
        const patch = await hook.beforePrompt?.(promptContext);
        if (patch?.prepend) prepend = [prepend, patch.prepend].filter(Boolean).join("\n\n");
        if (patch?.append) append = [append, patch.append].filter(Boolean).join("\n\n");
      }
      if (prepend.length === 0 && append.length === 0) return undefined;
      return {
        ...(prepend.length > 0 ? { prepend } : {}),
        ...(append.length > 0 ? { append } : {}),
      };
    },
    async formatReply(replyContext: PluginReplyContext): Promise<PluginReplyPlan | null> {
      for (const hook of hooks) {
        const plan = await hook.formatReply?.(replyContext);
        if (plan !== undefined && plan !== null) return plan;
      }
      return null;
    },
    async afterRun(runContext: PluginRunContext): Promise<void> {
      for (const hook of hooks) await hook.afterRun?.(runContext);
    },
    async emit<K extends keyof PluginEventMap>(type: K, event: PluginEventMap[K]): Promise<void> {
      for (const subscription of events) {
        if (subscription.type === type) await subscription.handler(event);
      }
    },
    async dispose(): Promise<void> {
      await definition.stop?.(context);
      for (const dispose of disposers.reverse()) await dispose();
      commands.clear();
      hooks.length = 0;
      events.length = 0;
      if (ownedDataDir) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function findCommand(
  commands: Map<string, PluginCommandDefinition>,
  name: string,
): PluginCommandDefinition | undefined {
  const normalized = name.toLowerCase();
  for (const command of commands.values()) {
    if (command.name === normalized) return command;
    if (command.aliases?.some((alias) => alias.toLowerCase() === normalized)) return command;
  }
  return undefined;
}

function makeMessage(overrides: Partial<PluginMessage> = {}): PluginMessage {
  const userId = overrides.userId ?? 10001;
  return {
    id: "test-message",
    chat: { type: "private", userId, chatKey: `private:${userId}` },
    userId,
    senderName: "Tester",
    text: "",
    images: [],
    mentionsBot: false,
    receivedAt: Date.now(),
    ...overrides,
  };
}

function silentLogger(): PluginLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
