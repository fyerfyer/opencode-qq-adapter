import { AgentUnavailableError, AgentVersionMismatchError } from "../opencode/errors.js";

export function isSessionMissing(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const cause = (error as { cause?: { status?: number } }).cause;
  if (cause?.status === 404) return true;
  const message = error instanceof Error ? error.message : "";
  return /session.*(not.?found|missing)|not.?found.*session/i.test(message);
}

export function friendlyError(error: unknown): string {
  if (error instanceof AgentUnavailableError) {
    return `OpenCode 服务不可用。${error.message}`;
  }
  if (error instanceof AgentVersionMismatchError) {
    return `OpenCode 版本不匹配：${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
