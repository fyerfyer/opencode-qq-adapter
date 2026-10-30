import type { ConversationRecord, RunRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionRuleset } from "../domain/permission.js";
import type { PluginConversationProfile } from "../plugins/sdk.js";

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RunUsage {
  cost: number;
  tokens: TokenTotals;
}

export interface ActiveRun {
  record: RunRecord;
  message: IncomingMessage;
  /** User text before plugin prompt injection. */
  rawText: string;
  permissions: PermissionRuleset;
  /** Plugin-selected directory/agent/model for this run. */
  profile: PluginConversationProfile | null;
  abort: AbortController;
  stopRequested: boolean;
  interrupted: boolean;
  agentError: string | null;
  /** Last model reported by OpenCode step events; useful when a run fails before final text. */
  agentName?: string | null;
  modelRef?: string | null;
  partialText: string;
  usage: RunUsage | null;
  workspaceId: string | null;
  workspacePath: string | null;
  /** Final assistant text once the run completes. */
  replyText: string | null;
}

export interface PendingRun {
  record: RunRecord;
  message: IncomingMessage;
  rawText: string;
  permissions: PermissionRuleset;
  profile: PluginConversationProfile | null;
}

export interface ChatState {
  active: ActiveRun | null;
  pending: PendingRun[];
  draining: boolean;
}

export interface SubmitResult {
  accepted: boolean;
  runId: string;
  queued: boolean;
  /** Present when the prompt was rejected for a transient reason. */
  reason?: string;
}

export interface MaintenanceGate {
  ok: boolean;
  reason?: string;
  activeRuns: number;
  queuedRuns: number;
  /** Prompts currently resolving plugin hooks before entering the queue. */
  pendingSubmissions?: number;
}

export interface ConversationStatus {
  conversation: ConversationRecord | null;
  activeRun: RunRecord | null;
  queued: number;
  recentRuns: RunRecord[];
}

export class RunStoppedError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "RunStoppedError";
  }
}
