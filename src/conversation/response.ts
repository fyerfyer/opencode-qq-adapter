import type { AgentMessage, AgentPort } from "../ports/agent.js";
import type { ActiveRun, RunUsage } from "./types.js";

export interface CollectedResponse {
  text: string;
  error: string | null;
  usage: RunUsage | null;
}

/** Extract assistant text/usage from messages created by the current prompt. */
export async function collectResponse(
  agent: AgentPort,
  sessionId: string,
  receipt: { messageId: string; created: number },
  active: ActiveRun,
): Promise<CollectedResponse> {
  const messages = await agent.listMessages(sessionId, 100);
  const userIndex = messages.findIndex(
    (entry) => entry.type === "user" && entry.id === receipt.messageId,
  );
  const relevant =
    userIndex >= 0
      ? messages.slice(0, userIndex)
      : messages.filter((entry) => entry.created >= receipt.created);
  // OpenCode message history is requested newest-first. Keep that order so the
  // first non-empty assistant message is the final answer.
  const assistant = relevant.filter((entry) => entry.type === "assistant");
  if (assistant.length === 0) {
    return { text: active.partialText, error: null, usage: active.usage };
  }
  const finalText =
    assistant.find((entry) => entry.text.trim().length > 0)?.text.trim() ?? active.partialText;
  const firstError = assistant.find((entry) => entry.error !== null)?.error ?? null;
  const usage = sumUsage(assistant);
  return {
    text: finalText,
    error: firstError,
    usage: usage ?? active.usage,
  };
}

export function sumUsage(messages: AgentMessage[]): RunUsage | null {
  let cost = 0;
  let hasCost = false;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let hasTokens = false;
  for (const message of messages) {
    if (message.cost !== null) {
      cost += message.cost;
      hasCost = true;
    }
    if (message.tokens !== null) {
      hasTokens = true;
      tokens.input += message.tokens.input;
      tokens.output += message.tokens.output;
      tokens.reasoning += message.tokens.reasoning;
      tokens.cacheRead += message.tokens.cacheRead;
      tokens.cacheWrite += message.tokens.cacheWrite;
    }
  }
  if (!hasCost && !hasTokens) return null;
  return { cost, tokens };
}

export { toPromptFiles } from "../media/inbound.js";
