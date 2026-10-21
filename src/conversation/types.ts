import type { ConversationRecord, RunRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionRuleset } from "../domain/permission.js";

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
  permissions: PermissionRuleset;
  abort: AbortController;
  stopRequested: boolean;
  interrupted: boolean;
  agentError: string | null;
  partialText: string;
  usage: RunUsage | null;
  workspaceId: string | null;
  workspacePath: string | null;
}

export interface PendingRun {
  record: RunRecord;
  message: IncomingMessage;
  permissions: PermissionRuleset;
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
