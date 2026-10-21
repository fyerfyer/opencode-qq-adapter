import type { ChatRef } from "./chat.js";

export interface IncomingImage {
  file?: string;
  url?: string;
  summary?: string;
  /** Absolute path of the downloaded copy in the bridge inbox. */
  localPath?: string;
  mime?: string;
}

export interface IncomingMessage {
  /** OneBot message_id represented as a string (QQ message IDs exceed 2^53 on some clients). */
  id: string;
  chat: ChatRef;
  userId: number;
  senderName: string;
  text: string;
  images: IncomingImage[];
  replyToId?: string;
  mentionsBot: boolean;
  receivedAt: number;
  raw: unknown;
}

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

const COMMAND_PATTERN = /^!([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (!match) return undefined;
  const name = match[1]?.toLowerCase();
  if (!name) return undefined;
  const rawArgs = (match[2] ?? "").trim();
  return {
    name,
    rawArgs,
    args: rawArgs.length > 0 ? rawArgs.split(/\s+/) : [],
  };
}
