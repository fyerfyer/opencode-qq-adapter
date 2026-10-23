import type {
  AgentPermissionRequest,
  ApprovalDecision,
  PermissionRuleset,
} from "../domain/permission.js";
import type { WorkspaceDiffFile } from "../domain/workspace.js";

export interface AgentHealth {
  healthy: boolean;
  version: string | null;
  url: string | null;
  checkedAt: number;
  error: string | null;
}

export interface AgentSessionInput {
  directory: string;
  title?: string;
  agent?: string | null;
  model?: string | null;
  permissions?: PermissionRuleset;
}

export interface AgentSession {
  id: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  projectId: string | null;
  created: number | null;
  updated: number | null;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
}

export interface AgentPromptInput {
  sessionId: string;
  text: string;
  files?: Array<{ uri: string; name?: string; description?: string }>;
}

export interface AgentPromptReceipt {
  messageId: string;
  created: number;
}

export interface AgentMessage {
  id: string;
  type: string;
  text: string;
  created: number;
  error: string | null;
  cost: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
}

export interface AgentEvent {
  type: string;
  sessionId: string | null;
  data: unknown;
  receivedAt: number;
}

export interface AgentEventStatus {
  connected: boolean;
  lastEventAt: number | null;
  lastError: string | null;
}

export interface AgentModel {
  /** `provider/modelID`, suitable for `!model`. */
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  variants: string[];
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  mode: "primary" | "subagent" | "all";
  model: string | null;
  hidden: boolean;
}

export interface AgentPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(force?: boolean): Promise<AgentHealth>;
  createSession(input: AgentSessionInput): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSession | null>;
  deleteSession(sessionId: string): Promise<void>;
  prompt(input: AgentPromptInput): Promise<AgentPromptReceipt>;
  waitForCompletion(sessionId: string, signal?: AbortSignal): Promise<void>;
  interrupt(sessionId: string): Promise<boolean>;
  updatePermissions(sessionId: string, permissions: PermissionRuleset): Promise<void>;
  listPermissions(sessionId: string): Promise<AgentPermissionRequest[]>;
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    message?: string,
  ): Promise<void>;
  listMessages(sessionId: string, limit?: number): Promise<AgentMessage[]>;
  listModels(directory?: string): Promise<AgentModel[]>;
  listAgents(directory?: string): Promise<AgentSummary[]>;
  listSessions(directory: string, limit?: number): Promise<AgentSession[]>;
  switchModel(sessionId: string, model: string): Promise<void>;
  switchAgent(sessionId: string, agent: string): Promise<void>;
  getDiff(sessionId: string): Promise<WorkspaceDiffFile[]>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  eventStatus(): AgentEventStatus;
  getLastError(): string | null;
}
