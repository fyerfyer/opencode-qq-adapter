const FENCE = /^\s*(```+|~~~+)/;

/** Convert common Markdown to text that renders cleanly in QQ. */
export function markdownToPlain(input: string): string {
  if (input.length === 0) return "";
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```";
      if (fence === null) {
        fence = marker;
      } else {
        fence = null;
      }
      output.push(line);
      continue;
    }
    if (fence !== null) {
      output.push(line);
      continue;
    }
    output.push(formatLine(line));
  }

  return output
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatLine(line: string): string {
  let value = line;
  value = value.replace(/^#{1,6}\s+/, "");
  value = value.replace(/^>\s?/, "");
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_all, alt: string, url: string) =>
    alt.length > 0 ? `[图片: ${alt}] ${url}` : `[图片] ${url}`,
  );
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  value = value.replace(/\*\*([^*]+)\*\*/g, "$1");
  value = value.replace(/__([^_]+)__/g, "$1");
  value = value.replace(/~~([^~]+)~~/g, "$1");
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1$2");
  value = value.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1$2");
  value = value.replace(/<\/?[A-Za-z][^>]*>/g, "");
  return value.replace(/[ \t]+$/g, "");
}

/**
 * Split long text into QQ-friendly chunks. Prefers paragraph boundaries, then
 * newlines, and keeps fenced code blocks balanced across chunks.
 */
export function splitMessage(input: string, maxLength: number): string[] {
  if (input.length === 0) return [];
  if (maxLength < 32) throw new Error("maxLength must be at least 32");
  if (input.length <= maxLength) return [input];

  const lines = input.split("\n");
  const chunks: string[] = [];
  let current = "";
  let fenceMarker: string | null = null;

  const flush = (next?: string) => {
    const suffix = fenceMarker !== null ? "\n```" : "";
    const value = `${current}${suffix}`.trim();
    if (value.length > 0) chunks.push(value);
    current = fenceMarker !== null && next !== undefined ? `${fenceMarker}\n${next}` : (next ?? "");
  };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    const isFence = fenceMatch !== null;
    const addition = current.length > 0 ? `\n${line}` : line;
    const projected = current.length + addition.length + (fenceMarker !== null ? 4 : 0);

    if (projected > maxLength && current.length > 0) {
      flush(line);
    } else {
      current += addition;
    }

    if (isFence) {
      const marker = fenceMatch?.[1] ?? "```";
      fenceMarker = fenceMarker === null ? marker : null;
    }
  }

  if (current.trim().length > 0) chunks.push(current.trim());

  // A single unbroken line can still exceed the limit. Hard-split those chunks.
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLength) {
      result.push(chunk);
      continue;
    }
    let remaining = chunk;
    while (remaining.length > maxLength) {
      let cut = remaining.lastIndexOf("\n", maxLength);
      if (cut < maxLength / 2) {
        cut = findNaturalCut(remaining, maxLength);
      }
      if (cut <= 0) cut = maxLength;
      result.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length > 0) result.push(remaining);
  }
  return result.filter((chunk) => chunk.length > 0);
}

function findNaturalCut(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const candidates = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "; ", ", ", " "];
  for (const candidate of candidates) {
    const index = window.lastIndexOf(candidate);
    if (index > limit / 2) return index + candidate.length;
  }
  return limit;
}
