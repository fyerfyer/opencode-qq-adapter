import type { PluginMessage, PluginQuotedMessage } from "@opencode-qq/plugin-sdk";

/**
 * Text used for worldbook and transcript retrieval.
 *
 * A quoted message is context the user explicitly attached, so its text should
 * participate in keyword matching even though the user's own message may be a
 * short follow-up such as “那这个呢”.
 */
export function promptQueryText(message: PluginMessage): string {
  const quote = message.quote;
  const quoted = quote?.available === true ? quote.text.trim() : "";
  return quoted.length > 0 ? `${quoted}\n${message.text}` : message.text;
}

/**
 * Mark quoted content when it is written to the raw transcript.
 *
 * The transcript schema has no dedicated quote column yet; prefixing the user
 * turn keeps the provenance visible without pretending the quote was typed by
 * the user.
 */
export function transcriptUserText(text: string, quote: PluginQuotedMessage | null): string {
  if (quote === null || !quote.available) return text;
  const body = [
    quote.text.trim(),
    ...quote.images.map(() => "[图片]"),
    ...quote.unsupported.map((type) => `[${type}]`),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  if (body.length === 0) return text;
  const sender = quote.senderName.trim();
  const marker = sender.length > 0 ? `[引用 ${sender}]` : "[引用消息]";
  return `${marker}\n${body}\n\n${text}`.trim();
}
