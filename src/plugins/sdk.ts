/**
 * Public Plugin SDK contract for opencode-qq-adapter.
 *
 * This file is the source of truth for `@opencode-qq/plugin-sdk`. It must stay
 * free of core-internal imports so third-party plugins can compile against it
 * without depending on the bridge implementation.
 *
 * The API is experimental in v0.1: additive changes are expected, breaking
 * changes require a new `PLUGIN_API_VERSION`.
 */

export const PLUGIN_API_VERSION = 1 as const;

export const PLUGIN_CAPABILITIES = [
  "commands",
  "hooks",
  "messages",
  "sessions",
  "events",
  "admin",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface PluginManifest {
  /** Globally unique id. Lowercase letters, digits and dashes. */
  id: string;
  name: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  description?: string;
  /** Declares which host APIs the plugin uses. */
  capabilities?: PluginCapability[];
  engines?: {
    /** semver range checked against the running bridge version. */
    opencodeQq?: string;
  };
}

export type PluginChatType = "private" | "group";
export type PluginRole = "owner" | "admin" | "member";

export interface PluginChat {
  type: PluginChatType;
  userId: number;
  groupId?: number;
  chatKey: string;
}

export interface PluginIncomingImage {
  file?: string;
  url?: string;
  summary?: string;
  localPath?: string;
  mime?: string;
}

export interface PluginMessage {
  id: string;
  chat: PluginChat;
  userId: number;
  senderName: string;
  text: string;
  images: PluginIncomingImage[];
  replyToId?: string;
  mentionsBot: boolean;
  receivedAt: number;
}

export interface PluginActor {
  qq: number;
  role: PluginRole;
}

export interface PluginConversation {
  projectId: string;
  workspaceId: string | null;
  sessionId: string | null;
  agent: string | null;
  model: string | null;
}

export interface PluginSendResult {
  messageId: string;
}

export interface PluginImageInput {
  /**
   * Path relative to the plugin data directory. Absolute paths are accepted
   * only when they resolve inside the same directory.
   */
  path: string;
  caption?: string;
}

export interface PluginFileInput extends PluginImageInput {
  /** Display name; defaults to the source file name. */
  name?: string;
}

/** Outbound messaging API bound to the plugin data directory. */
export interface PluginMessages {
  reply(message: PluginMessage, text: string): Promise<PluginSendResult>;
  send(chat: PluginChat, text: string): Promise<PluginSendResult>;
  sendImage(chat: PluginChat, input: PluginImageInput): Promise<PluginSendResult>;
  sendFile(chat: PluginChat, input: PluginFileInput): Promise<PluginSendResult>;
}

export interface PluginLogger {
  debug(detail: unknown, message?: string): void;
  info(detail: unknown, message?: string): void;
  warn(detail: unknown, message?: string): void;
  error(detail: unknown, message?: string): void;
}

export interface PluginCommandContext {
  message: PluginMessage;
  args: string[];
  rawArgs: string;
  actor: PluginActor;
  conversation: PluginConversation | null;
  logger: PluginLogger;
  reply(text: string): Promise<PluginSendResult>;
  sendImage(input: PluginImageInput): Promise<PluginSendResult>;
  sendFile(input: PluginFileInput): Promise<PluginSendResult>;
}

export interface PluginCommandDefinition {
  /** Command name without the leading `!`. */
  name: string;
  aliases?: string[];
  description?: string;
  usage?: string;
  /** Allowed roles. Defaults to every authenticated user. */
  roles?: PluginRole[];
  /** Allowed chat types. Defaults to both private and group. */
  chats?: PluginChatType[];
  /** Shared-group commands are opt-in because they affect every member. */
  allowGroupShared?: boolean;
  handler(context: PluginCommandContext): string | void | Promise<string | void>;
}

export interface PluginCommands {
  register(command: PluginCommandDefinition): () => void;
  unregister(name: string): void;
}

export interface PluginPromptContext {
  message: PluginMessage;
  projectId: string;
  conversation: PluginConversation | null;
}

export interface PluginPromptPatch {
  /** Inserted before the original prompt text. */
  prepend?: string;
  /** Appended after the original prompt text. */
  append?: string;
}

export interface PluginTokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PluginRunUsage {
  cost: number;
  tokens: PluginTokenTotals;
}

export type PluginRunStatus = "completed" | "failed" | "interrupted";

export interface PluginRunContext {
  runId: string;
  chat: PluginChat;
  userId: number;
  projectId: string;
  workspaceId: string | null;
  sessionId: string | null;
  status: PluginRunStatus;
  usage: PluginRunUsage | null;
  error: string | null;
  durationMs: number;
  promptText: string;
}

export interface PluginConfigReloadContext {
  applied: string[];
  restartRequired: string[];
}

export interface PluginHooksDefinition {
  /** Called for every prompt before it enters the run queue. */
  beforePrompt?(
    context: PluginPromptContext,
  ): PluginPromptPatch | void | Promise<PluginPromptPatch | void>;
  /** Called once a run reaches a terminal state. Failures are isolated. */
  afterRun?(context: PluginRunContext): void | Promise<void>;
  /** Called after the core configuration has been hot-reloaded. */
  onConfigReload?(context: PluginConfigReloadContext): void | Promise<void>;
}

export interface PluginHooks {
  register(hooks: PluginHooksDefinition): () => void;
}

export interface PluginEventMap {
  "run.finished": PluginRunContext;
  "config.reloaded": PluginConfigReloadContext;
}

export interface PluginEvents {
  on<K extends keyof PluginEventMap>(
    type: K,
    handler: (event: PluginEventMap[K]) => void | Promise<void>,
  ): () => void;
}

/** Read-only view of the current conversation binding. */
export interface PluginSessions {
  get(chatKey: string): PluginConversation | null;
}

/** Small filesystem helper rooted at the plugin data directory. */
export interface PluginStorage {
  readonly dir: string;
  readText(name: string): Promise<string | null>;
  writeText(name: string, content: string): Promise<void>;
  readJson<T = unknown>(name: string): Promise<T | null>;
  writeJson(name: string, value: unknown): Promise<void>;
}

export interface PluginOptionsSchema<T> {
  parse(input: unknown): T;
}

export interface PluginContext<TOptions = Record<string, unknown>> {
  manifest: Readonly<PluginManifest>;
  config: TOptions;
  dataDir: string;
  logger: PluginLogger;
  storage: PluginStorage;
  commands: PluginCommands;
  hooks: PluginHooks;
  messages: PluginMessages;
  sessions: PluginSessions;
  events: PluginEvents;
}

export type PluginDisposer = () => void | Promise<void>;

export interface PluginDefinition<TOptions = Record<string, unknown>> {
  /**
   * Optional when the manifest lives in `package.json` under `opencodeQq`.
   * If both exist, the exported manifest wins after id/version consistency
   * checks.
   */
  manifest?: PluginManifest;
  /** Optional runtime validation for the YAML `options` object. */
  options?: PluginOptionsSchema<TOptions>;
  setup(context: PluginContext<TOptions>): void | PluginDisposer | Promise<void | PluginDisposer>;
  start?(context: PluginContext<TOptions>): void | Promise<void>;
  stop?(context: PluginContext<TOptions>): void | Promise<void>;
}

/** Identity helper that preserves option and command types. */
export function definePlugin<TOptions = Record<string, unknown>>(
  definition: PluginDefinition<TOptions>,
): PluginDefinition<TOptions> {
  return definition;
}

/** Identity helper for command definitions. */
export function defineCommand<T extends PluginCommandDefinition>(command: T): T {
  return command;
}
