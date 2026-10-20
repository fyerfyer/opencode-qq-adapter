import { type GroupMode, groupChat, privateChat } from "../domain/chat.js";
import type { IncomingImage, IncomingMessage } from "../domain/message.js";
import type { OneBotMessageEvent, OneBotSegment } from "./protocol.js";

const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

export function parseCQString(input: string): OneBotSegment[] {
  const segments: OneBotSegment[] = [];
  let lastIndex = 0;
  CQ_PATTERN.lastIndex = 0;
  for (;;) {
    const match = CQ_PATTERN.exec(input);
    if (match === null) break;
    const before = input.slice(lastIndex, match.index);
    if (before.length > 0) {
      segments.push({ type: "text", data: { text: decodeCQText(before) } });
    }
    const type = match[1] ?? "text";
    const data = parseCQData(match[2] ?? "");
    segments.push({ type, data });
    lastIndex = match.index + match[0].length;
  }
  const tail = input.slice(lastIndex);
  if (tail.length > 0) {
    segments.push({ type: "text", data: { text: decodeCQText(tail) } });
  }
  return segments;
}

function parseCQData(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 0) continue;
    const key = trimmed.slice(0, equals);
    const value = decodeCQText(trimmed.slice(equals + 1));
    result[key] = value;
  }
  return result;
}

function decodeCQText(input: string): string {
  return input
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&#44;", ",")
    .replaceAll("&amp;", "&");
}

export function normalizeSegments(event: OneBotMessageEvent): OneBotSegment[] {
  if (Array.isArray(event.message)) return event.message;
  return parseCQString(event.message);
}

export interface SegmentSummary {
  text: string;
  images: IncomingImage[];
  replyToId: string | null;
  mentioned: Set<string>;
  atAll: boolean;
  hasUnsupported: boolean;
  unsupportedTypes: string[];
}

export function summarizeSegments(segments: OneBotSegment[]): SegmentSummary {
  const textParts: string[] = [];
  const images: IncomingImage[] = [];
  const mentioned = new Set<string>();
  const unsupportedTypes = new Set<string>();
  let replyToId: string | null = null;
  let atAll = false;

  for (const segment of segments) {
    const data = segment.data ?? {};
    switch (segment.type) {
      case "text":
        if (typeof data.text === "string") textParts.push(data.text);
        break;
      case "at": {
        const qq = data.qq;
        if (qq === "all") {
          atAll = true;
        } else if (typeof qq === "string" || typeof qq === "number") {
          mentioned.add(String(qq));
        }
        break;
      }
      case "reply": {
        const id = data.id;
        if (typeof id === "string" || typeof id === "number") replyToId = String(id);
        break;
      }
      case "image": {
        images.push({
          ...(typeof data.file === "string" ? { file: data.file } : {}),
          ...(typeof data.url === "string" ? { url: data.url } : {}),
          ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
        });
        break;
      }
      case "face":
      case "mface":
      case "record":
      case "video":
      case "file":
        unsupportedTypes.add(segment.type);
        break;
      default:
        unsupportedTypes.add(segment.type === undefined ? "unknown" : segment.type);
    }
  }

  return {
    text: textParts.join("").trim(),
    images,
    replyToId,
    mentioned,
    atAll,
    hasUnsupported: unsupportedTypes.size > 0,
    unsupportedTypes: [...unsupportedTypes],
  };
}

export function toIncomingMessage(
  event: OneBotMessageEvent,
  selfId: number | null,
  resolveGroupMode: (groupId: number) => GroupMode,
): IncomingMessage {
  const segments = normalizeSegments(event);
  const summary = summarizeSegments(segments);
  const userId = Number(event.user_id);
  const botId = selfId ?? Number(event.self_id);
  const mentionsBot = summary.mentioned.has(String(botId)) || summary.atAll;

  let chat: ReturnType<typeof privateChat>;
  if (event.message_type === "group") {
    const groupId = groupIdFromEvent(event);
    chat = groupChat(groupId, userId, resolveGroupMode(groupId));
  } else {
    chat = privateChat(userId);
  }

  return {
    id: String(event.message_id),
    chat,
    userId,
    senderName: event.sender?.card || event.sender?.nickname || String(userId),
    text: summary.text,
    images: summary.images,
    ...(summary.replyToId !== null ? { replyToId: summary.replyToId } : {}),
    mentionsBot,
    receivedAt: event.time > 0 ? event.time * 1000 : Date.now(),
    raw: event,
  };
}

function groupIdFromEvent(event: OneBotMessageEvent): number {
  const groupId = Number(event.group_id);
  if (!Number.isFinite(groupId) || groupId <= 0) {
    throw new Error("Group message event is missing a valid group_id");
  }
  return groupId;
}
