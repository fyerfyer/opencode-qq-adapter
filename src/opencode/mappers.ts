import type { AgentPermissionRequest } from "../domain/permission.js";
import type { AgentMessage, AgentSession } from "../ports/agent.js";
import { AgentError } from "./errors.js";

export interface RawEvent {
  type: string;
  data?: unknown;
}

export function parseModelRef(value: string): { providerID: string; id: string; variant?: string } {
  const [modelPart = value, variant] = value.split("#", 2);
  const slash = modelPart.indexOf("/");
  if (slash <= 0 || slash === modelPart.length - 1) {
    throw new AgentError(`Invalid model reference '${value}'; expected 'provider/model'`);
  }
  const providerID = modelPart.slice(0, slash);
  const id = modelPart.slice(slash + 1);
  return { providerID, id, ...(variant ? { variant } : {}) };
}

export function basicAuthHeader(
  username: string,
  password: string,
): Record<string, string> | undefined {
  if (password.length === 0) return undefined;
  const user = username.length > 0 ? username : "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

export function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const cause = (error as { cause?: { status?: number } }).cause;
  if (cause?.status === 404) return true;
  const message = error instanceof Error ? error.message : "";
  return /not.?found/i.test(message);
}

export function extractSessionId(event: RawEvent): string | null {
  if (event.data === null || typeof event.data !== "object") return null;
  const data = event.data as Record<string, unknown>;
  if (typeof data.sessionID === "string") return data.sessionID;
  if (typeof data.sessionId === "string") return data.sessionId;
  const item = data.item;
  if (item !== null && typeof item === "object") {
    const sessionID = (item as Record<string, unknown>).sessionID;
    if (typeof sessionID === "string") return sessionID;
  }
  return null;
}

export function formatStructuredError(value: unknown): string {
  if (value === null || typeof value !== "object") return "Unknown OpenCode error";
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "error";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
  return `${type}: ${message}`;
}

export function mapSession(session: {
  id: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  projectID?: string;
  time?: { created?: number; updated?: number };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}): AgentSession {
  return {
    id: session.id,
    title: session.title ?? null,
    agent: session.agent ?? null,
    model: session.model ? `${session.model.providerID}/${session.model.id}` : null,
    projectId: session.projectID ?? null,
    created: session.time?.created ?? null,
    updated: session.time?.updated ?? null,
    cost: session.cost ?? 0,
    tokens: session.tokens
      ? {
          input: session.tokens.input,
          output: session.tokens.output,
          reasoning: session.tokens.reasoning,
          cacheRead: session.tokens.cache.read,
          cacheWrite: session.tokens.cache.write,
        }
      : null,
  };
}

export function mapPermissionRequest(request: {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}): AgentPermissionRequest {
  return {
    id: request.id,
    sessionId: request.sessionID,
    action: request.action,
    resources: [...request.resources],
    save: [...(request.save ?? [])],
    message: request.message ?? null,
    metadata: request.metadata ?? null,
  };
}

export function mapMessage(message: {
  id: string;
  type: string;
  time?: { created?: number };
  text?: string;
  error?: { type: string; message: string };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  content?: Array<{ type: string; text?: string }>;
}): AgentMessage {
  let text = message.text ?? "";
  if (message.type === "assistant") {
    const parts = message.content ?? [];
    if (parts.length > 0) {
      // OpenCode text parts can contain narration before a tool call. Only the
      // parts after the last tool call belong to the final answer.
      const lastTool = parts.findLastIndex((part) => part.type === "tool");
      const finalParts = lastTool >= 0 ? parts.slice(lastTool + 1) : parts;
      text = finalParts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
  }
  return {
    id: message.id,
    type: message.type,
    text,
    created: message.time?.created ?? 0,
    error: message.error ? `${message.error.type}: ${message.error.message}` : null,
    cost: message.cost ?? null,
    tokens: message.tokens
      ? {
          input: message.tokens.input,
          output: message.tokens.output,
          reasoning: message.tokens.reasoning,
          cacheRead: message.tokens.cache.read,
          cacheWrite: message.tokens.cache.write,
        }
      : null,
  };
}
