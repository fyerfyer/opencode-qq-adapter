export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotSender {
  user_id: number | string;
  nickname?: string;
  card?: string;
}

export interface OneBotMessageEvent {
  time: number;
  self_id: number | string;
  post_type: "message";
  message_type: "private" | "group";
  sub_type?: string;
  message_id: number | string;
  message_seq?: number | string;
  user_id: number | string;
  group_id?: number | string;
  message: string | OneBotSegment[];
  raw_message?: string;
  font?: number;
  sender?: OneBotSender;
}

export interface OneBotMetaEvent {
  time: number;
  self_id: number | string;
  post_type: "meta_event";
  meta_event_type: "lifecycle" | "heartbeat" | string;
  status?: Record<string, unknown>;
  interval?: number;
}

export interface OneBotNoticeEvent {
  time: number;
  self_id: number | string;
  post_type: "notice";
  notice_type: string;
  [key: string]: unknown;
}

export interface OneBotRequestEvent {
  time: number;
  self_id: number | string;
  post_type: "request";
  request_type: string;
  [key: string]: unknown;
}

export type OneBotEvent =
  | OneBotMessageEvent
  | OneBotMetaEvent
  | OneBotNoticeEvent
  | OneBotRequestEvent;

export function isMessageEvent(event: OneBotEvent): event is OneBotMessageEvent {
  return event.post_type === "message";
}
