import type { MemorySnippet } from "./memory.js";
import { formatTimestamp } from "./time.js";
import type { WorldbookEntry } from "./worldbook.js";

export interface PromptContextInput {
  personaName: string;
  userName: string;
  now: number;
  turnCount: number;
  worldbook: WorldbookEntry[];
  memories: MemorySnippet[];
  firstMes?: string;
  maxChars: number;
}

/**
 * Build the volatile user-message prefix. Stable character data lives in
 * AGENTS.md; this block only carries per-turn retrieval context.
 */
export function buildContextBlock(input: PromptContextInput): string {
  if (input.maxChars <= 0) return "";
  const lines: string[] = [
    "[检索上下文 · 不是用户发言]",
    `当前时间：${formatTimestamp(input.now)}`,
    `你正在扮演：${input.personaName}`,
    `对话对象：${input.userName}（第 ${input.turnCount} 轮）`,
  ];

  if (input.worldbook.length > 0) {
    lines.push("[世界书]", ...input.worldbook.map((entry) => `- ${entry.content}`));
  }
  if (input.memories.length > 0) {
    lines.push(
      "[记忆]",
      ...input.memories.map(
        (memory) =>
          `- [${formatTimestamp(memory.ts)}] ${memory.role === "user" ? memory.speaker : "你"}：${memory.text}`,
      ),
    );
  }
  if (input.firstMes !== undefined && input.firstMes.trim().length > 0) {
    lines.push(`你刚才对${input.userName}说：${input.firstMes.trim()}`);
  }
  lines.push("[/检索上下文]");

  const block = lines.join("\n");
  if (block.length <= input.maxChars) return block;
  const suffix = "\n[/检索上下文]";
  const head = block.slice(0, Math.max(0, input.maxChars - suffix.length - 1));
  return `${head.trimEnd()}…${suffix}`.slice(0, input.maxChars);
}
