import type { AgentEvent } from "../ports/agent.js";
import type { ActiveRun, TokenTotals } from "./types.js";

/** Apply one OpenCode event to the active run it belongs to. */
export function applyAgentEvent(active: ActiveRun, event: AgentEvent): void {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "session.execution.failed": {
      active.agentError = formatEventError(data.error);
      break;
    }
    case "session.execution.interrupted":
      active.interrupted = true;
      break;
    case "session.text.delta": {
      if (typeof data.delta === "string" && active.partialText.length < 4000) {
        active.partialText += data.delta;
      }
      break;
    }
    case "session.usage.updated": {
      if (typeof data.cost === "number") {
        active.usage = {
          cost: data.cost,
          tokens: parseTokens(data.tokens),
        };
      }
      break;
    }
    default:
      break;
  }
}

export function parseTokens(value: unknown): TokenTotals {
  if (value === null || typeof value !== "object") {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const token = value as Record<string, unknown>;
  const cache = (token.cache ?? {}) as Record<string, unknown>;
  return {
    input: numberOrZero(token.input),
    output: numberOrZero(token.output),
    reasoning: numberOrZero(token.reasoning),
    cacheRead: numberOrZero(cache.read),
    cacheWrite: numberOrZero(cache.write),
  };
}

export function formatEventError(value: unknown): string {
  if (value === null || typeof value !== "object") return "OpenCode execution failed";
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "error";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
  return `${type}: ${message}`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
