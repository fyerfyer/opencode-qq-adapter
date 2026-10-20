export type ChatType = "private" | "group";
export type GroupMode = "per_user" | "shared" | "readonly";

export interface ChatRef {
  type: ChatType;
  /** QQ number of the message sender. */
  userId: number;
  groupId?: number;
  /** Stable key used for conversation/workspace isolation. */
  chatKey: string;
}

export function privateChat(userId: number): ChatRef {
  return { type: "private", userId, chatKey: `private:${userId}` };
}

export function groupChat(groupId: number, userId: number, mode: GroupMode): ChatRef {
  const chatKey = mode === "shared" ? `group:${groupId}` : `group:${groupId}:${userId}`;
  return { type: "group", userId, groupId, chatKey };
}

export interface OutgoingTextSegment {
  type: "text";
  text: string;
}

export interface OutgoingAtSegment {
  type: "at";
  qq: string | "all";
}

export interface OutgoingReplySegment {
  type: "reply";
  messageId: string;
}

export interface OutgoingImageSegment {
  type: "image";
  /** Local path, http(s) URL, or base64:// payload. */
  file: string;
}

export interface OutgoingFileSegment {
  type: "file";
  file: string;
  name?: string;
}

export type OutgoingSegment =
  | OutgoingTextSegment
  | OutgoingAtSegment
  | OutgoingReplySegment
  | OutgoingImageSegment
  | OutgoingFileSegment;

export function textSegment(text: string): OutgoingTextSegment {
  return { type: "text", text };
}

export function replySegment(messageId: string): OutgoingReplySegment {
  return { type: "reply", messageId };
}

export function atSegment(qq: string | number): OutgoingAtSegment {
  return { type: "at", qq: String(qq) };
}
