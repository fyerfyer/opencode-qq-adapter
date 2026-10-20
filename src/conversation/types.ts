import type { ConversationRecord, RunRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";

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
  abort: AbortController;
  stopRequested: boolean;
  interrupted: boolean;
  agentError: string | null;
  partialText: string;
  usage: RunUsage | null;
}

export interface PendingRun {
  record: RunRecord;
  message: IncomingMessage;
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
