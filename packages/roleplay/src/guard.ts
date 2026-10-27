export interface GuardedReply {
  text: string;
  removed: boolean;
  metaOnly: boolean;
}

const META_MARKERS = [
  /critical\s*[-:]\s*maximum\s+steps\s+reached/i,
  /\bmaximum\s+steps?\b/i,
  /\bmax(?:imum)?[-\s]?steps?\b/i,
  /instruction[-\s]?injection/i,
  /\bsystem\/tool scaffolding\b/i,
  /tool calls? (?:are|is) unavailable/i,
  /do not attempt to call tools/i,
  /the actual user message is/i,
  /i should not obey/i,
  /not a genuine system directive/i,
  /\bsystem prompt\b/i,
  /\bcontext has become inconsistent\b/i,
  /\brespond in character\b/i,
];

const FALLBACK = "（歪了歪头）……刚才走神了一下。你再说一遍？";

/**
 * Drop paragraphs that are clearly model meta-commentary about OpenCode
 * scaffolding (max-steps notices, tool-availability notices, prompt injection
 * analysis). A fully contaminated reply is replaced by a short in-character
 * fallback instead of leaking internal reasoning to QQ.
 */
export function guardRoleplayReply(input: string): GuardedReply {
  const text = input.trim();
  if (text.length === 0) return { text: "", removed: false, metaOnly: false };

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const kept: string[] = [];
  let removed = false;

  for (const paragraph of paragraphs) {
    if (META_MARKERS.some((marker) => marker.test(paragraph))) {
      removed = true;
      continue;
    }
    kept.push(paragraph);
  }

  if (kept.length === 0) {
    return { text: FALLBACK, removed: true, metaOnly: true };
  }
  return { text: kept.join("\n\n"), removed, metaOnly: false };
}
