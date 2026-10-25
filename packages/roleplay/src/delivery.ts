export interface DeliveryOptions {
  maxSegments: number;
  maxChars: number;
  delayPerCharMs: number;
  maxDelayMs: number;
}

export interface ReplySegment {
  text: string;
  delayMs?: number;
}

export interface ReplyImageSegment {
  image: {
    path: string;
    caption?: string;
  };
  delayMs?: number;
}

export type ReplyPlanSegment = ReplySegment | ReplyImageSegment;

export interface StickerPlanInput {
  /** Path relative to the plugin data directory. */
  path: string;
  delayMs?: number;
}

/**
 * Roleplay replies are prose, not Markdown. Strip the formatting that QQ would
 * otherwise render literally without changing the words.
 */
export function plainText(input: string): string {
  let text = input.replace(/\r\n/g, "\n");
  text = text.replace(/```[^\n]*\n?/g, "");
  text = text.replace(/^#{1,6}[ \t]+/gm, "");
  text = text.replace(/^>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Split prose into a small number of QQ-sized bubbles. */
export function splitReply(input: string, options: DeliveryOptions): string[] {
  const text = plainText(input);
  if (text.length === 0) return [];
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const maxSegments = Math.max(1, Math.floor(options.maxSegments));

  const units = text
    .split(/(?<=[。！？!?…])\s*|\n+/u)
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
  const source = units.length > 0 ? units : [text];

  // Short replies should still feel like separate chat bubbles: one sentence
  // per bubble when the sentence count already fits the segment budget.
  if (source.length <= maxSegments && source.every((unit) => unit.length <= maxChars)) {
    return source;
  }

  const totalChars = source.reduce((sum, unit) => sum + unit.length, 0);
  const targetChars = Math.min(maxChars, Math.max(1, Math.ceil(totalChars / maxSegments)));
  const segments: string[] = [];
  let current = "";
  const push = (value: string): void => {
    if (value.trim().length > 0) segments.push(value.trim());
  };

  for (const unit of source) {
    if (unit.length > maxChars) {
      push(current);
      current = "";
      for (let index = 0; index < unit.length; index += maxChars) {
        push(unit.slice(index, index + maxChars));
      }
      continue;
    }
    if (current.length > 0 && current.length + unit.length > targetChars) {
      push(current);
      current = "";
    }
    current += unit;
  }
  push(current);

  while (segments.length > maxSegments) {
    const tail = segments.pop();
    if (tail === undefined) break;
    const previous = segments.pop() ?? "";
    segments.push(previous + tail);
  }
  return segments;
}

/** Turn a final reply into ordered segments with human-like typing delays. */
export function planReply(input: string, options: DeliveryOptions): ReplySegment[] {
  const segments = splitReply(input, options);
  return segments.map((text, index) => {
    if (index === 0) return { text };
    const delayMs = Math.min(
      Math.max(0, options.maxDelayMs),
      Math.max(250, Math.round(text.length * Math.max(0, options.delayPerCharMs))),
    );
    return { text, ...(delayMs > 0 ? { delayMs } : {}) };
  });
}

/** Append at most one sticker after the text bubbles. */
export function planReplyWithSticker(
  input: string,
  options: DeliveryOptions,
  sticker: StickerPlanInput | null,
): ReplyPlanSegment[] {
  const text = planReply(input, options);
  if (sticker === null) return text;
  const delayMs =
    sticker.delayMs !== undefined && sticker.delayMs > 0
      ? Math.min(5000, Math.max(0, Math.floor(sticker.delayMs)))
      : undefined;
  const image: ReplyImageSegment = {
    image: { path: sticker.path },
    ...(delayMs !== undefined ? { delayMs } : {}),
  };
  return text.length === 0 ? [image] : [...text, image];
}
