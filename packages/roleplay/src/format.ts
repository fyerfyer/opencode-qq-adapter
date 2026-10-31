import { basename } from "node:path";
import type { MemoryEvent } from "@opencode-qq/memory";
import { docForPrompt, type MemoryDoc } from "./memory-document.js";
import type { MemorySearchResult, MemoryView } from "./memory-service.js";
import { formatTimestamp } from "./time.js";

const MEMORY_OUTPUT_CHARS = 1800;

export function capText(text: string, maxChars = MEMORY_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function formatDoc(title: string, doc: MemoryDoc): string {
  const content = doc.content.trim().length > 0 ? docForPrompt(doc.content, 4000) : "";
  return `${title}\n${content.length > 0 ? content : "（空）"}`;
}

export function formatMemoryView(personaName: string, view: MemoryView): string {
  const lines: string[] = [`角色：${personaName}`];
  if (view.shared) {
    lines.push(formatDoc("[群聊场景]", view.scene ?? emptyDoc()));
    if (view.allUsers.length > 0) {
      lines.push("[群成员记忆]");
      for (const doc of view.allUsers) {
        const id = basename(doc.path, ".md");
        lines.push(formatDoc(`群友 ${id}`, doc));
      }
    } else {
      lines.push(formatDoc("[我的记忆]", view.user));
    }
  } else {
    lines.push(formatDoc("[长期记忆]", view.user));
  }
  lines.push(`原文：${view.rawCount} 条`);
  if (view.lastEvent !== null) {
    lines.push(
      `最近变更：${formatTimestamp(view.lastEvent.createdAt)} · ${view.lastEvent.summary}`,
    );
  }
  lines.push(
    "用法：!memory search 关键词 | !memory diff | !memory history | !memory refresh | !remember 内容 | !forget confirm",
  );
  return capText(lines.join("\n"));
}

export function emptyDoc(): MemoryDoc {
  return { path: "", content: "", exists: false, updatedAt: null };
}

export function formatHistory(events: MemoryEvent[]): string {
  if (events.length === 0) return "还没有记忆变更。";
  return capText(
    [
      `最近记忆变更（${events.length}）：`,
      ...events.map(
        (event) =>
          `- [${formatTimestamp(event.createdAt)}] ${event.action} · ${event.summary}`,
      ),
    ].join("\n"),
  );
}

export function formatDiff(event: MemoryEvent | null): string {
  if (event === null) return "还没有记忆变更。";
  const lines = [
    `最近变更：${formatTimestamp(event.createdAt)} · ${event.action}`,
    event.summary,
  ];
  const detail = event.detail;
  if (detail !== null) {
    lines.push(...formatOperations("用户", detail.user));
    lines.push(...formatOperations("群聊", detail.scene));
  }
  if (lines.length === 2) lines.push("（没有 section 级变更记录）");
  return capText(lines.join("\n"));
}

function formatOperations(label: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const lines: string[] = [`${label}操作：`];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const section = typeof record.section === "string" ? record.section : "?";
    const op = typeof record.op === "string" ? record.op : "?";
    const reason = typeof record.reason === "string" ? `（${record.reason}）` : "";
    lines.push(`- ${section} · ${op}${reason}`);
  }
  return lines;
}

export function formatSearch(result: MemorySearchResult): string {
  const lines: string[] = [];
  for (const doc of result.docs) {
    lines.push(`- [${doc.source} · ${doc.section}] ${doc.line}`);
  }
  if (result.messages.length > 0) {
    lines.push(
      "[原文]",
      ...result.messages.map(
        (message) =>
          `- [${formatTimestamp(message.ts)}] ${message.role === "user" ? message.speaker : "你"}：${message.text}`,
      ),
    );
  }
  return lines.length > 0 ? capText(lines.join("\n")) : "没有匹配的记忆。";
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
