import type { Logger } from "pino";
import type { AppConfig, PluginConfig } from "../../config/schema.js";
import type { GroupMode } from "../../domain/chat.js";
import type { ConversationRecord } from "../../domain/conversation.js";
import type { IncomingMessage } from "../../domain/message.js";
import type { AuditTrail } from "../../observability/audit.js";
import type { AgentPort } from "../../ports/agent.js";
import type { MessageSender } from "../../qq/sender.js";
import type {
  PluginAdminHandler,
  PluginAdminMethod,
  PluginAdminPage,
  PluginCommandDefinition,
  PluginContext,
  PluginConversationProfile,
  PluginDefinition,
  PluginDisposer,
  PluginEventMap,
  PluginHooksDefinition,
  PluginManifest,
  PluginRole,
  PluginSessionMutationResult,
} from "../sdk.js";

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
  sourceKind: "path" | "package";
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

export interface RegisteredCommand {
  definition: PluginCommandDefinition;
  names: string[];
}

export interface RegisteredHook {
  definition: PluginHooksDefinition;
}

export interface RegisteredAdminRoute {
  method: PluginAdminMethod;
  pattern: string;
  segments: AdminPathSegment[];
  handler: PluginAdminHandler;
  order: number;
}

export type AdminPathSegment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard" };

export interface EventSubscription {
  type: keyof PluginEventMap;
  handler: (event: unknown) => void | Promise<void>;
}

export interface PluginInstance {
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
