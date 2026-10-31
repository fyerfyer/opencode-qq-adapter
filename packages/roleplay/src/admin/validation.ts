import type { PluginChat } from "@opencode-qq/plugin-sdk";
import { AdminHttpError } from "./http.js";

export const PERSONA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MEMORY_SCOPE = /^[A-Za-z0-9._-]{1,120}$/;
export const MAX_CARD_BYTES = 25 * 1024 * 1024;

export function chatFromKey(chatKey: string): PluginChat | null {
  const privateMatch = /^private:(\d{5,12})$/.exec(chatKey);
  if (privateMatch?.[1] !== undefined) {
    const userId = Number(privateMatch[1]);
    return { type: "private", userId, chatKey };
  }
  const groupMatch = /^group:(\d+)(?::(\d+))?$/.exec(chatKey);
  if (groupMatch?.[1] !== undefined) {
    return {
      type: "group",
      userId: Number(groupMatch[2] ?? 0),
      groupId: Number(groupMatch[1]),
      chatKey,
    };
  }
  return null;
}

export function jevTextOverride(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AdminHttpError(400, "invalid_jev_setting", `${label} 必须是字符串。`);
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > maxLength || /[\r\n\0]/.test(text)) {
    throw new AdminHttpError(400, "invalid_jev_setting", `${label} 不合法。`);
  }
  return text;
}

export function jevBaseUrlOverride(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AdminHttpError(400, "invalid_jev_base_url", "Jev Base URL 不合法。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AdminHttpError(
      400,
      "invalid_jev_base_url",
      "Jev Base URL 必须以 http:// 或 https:// 开头。",
    );
  }
  return value;
}

export function jevTimeoutOverride(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdminHttpError(400, "invalid_jev_setting", "超时时间必须是数字。");
  }
  return Math.min(4000, Math.max(300, Math.round(value)));
}
