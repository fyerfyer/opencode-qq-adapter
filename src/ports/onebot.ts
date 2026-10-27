import type { ChatRef, OutgoingSegment } from "../domain/chat.js";

export interface OneBotStatus {
  mode: "forward";
  connected: boolean;
  /** Whether NapCat reports a valid QQ login. `null` means unknown/not checked. */
  loginOk: boolean | null;
  selfId: number | null;
  lastEventAt: number | null;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export interface OneBotSendResult {
  messageId: string | null;
}

export interface OneBotPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendPrivate(userId: number, segments: OutgoingSegment[]): Promise<OneBotSendResult>;
  sendGroup(groupId: number, segments: OutgoingSegment[]): Promise<OneBotSendResult>;
  reply(chat: ChatRef, messageId: string, segments: OutgoingSegment[]): Promise<OneBotSendResult>;
  uploadPrivateFile(userId: number, file: string, name: string): Promise<void>;
  uploadGroupFile(groupId: number, file: string, name: string, folderId?: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  /** Resolve a NapCat image reference (the `file` field of an image segment). */
  getImage(file: string): Promise<{ file: string; url: string; fileName: string }>;
  getLoginInfo?(): Promise<{ userId: number; nickname: string }>;
  status(): OneBotStatus;
  onEvent(listener: (event: unknown) => void): () => void;
}
