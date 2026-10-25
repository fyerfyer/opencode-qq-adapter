/** Internal reply plan after plugin images have been resolved and validated. */
export interface ResolvedTextReplySegment {
  kind: "text";
  text: string;
  delayMs?: number;
}

export interface ResolvedImageReplySegment {
  kind: "image";
  /** base64:// payload ready for OneBot. */
  dataUri: string;
  caption?: string;
  bytes: number;
  mime: string;
  pluginId: string;
  sourcePath: string;
  delayMs?: number;
}

export type ResolvedReplySegment = ResolvedTextReplySegment | ResolvedImageReplySegment;

export interface ResolvedReplyPlan {
  segments: ResolvedReplySegment[];
  suppress?: boolean;
  replyText?: string | null;
}
