export interface WorldbookEntry {
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  caseSensitive: boolean;
  matchWholeWords?: boolean;
  priority: number;
  insertionOrder: number;
  position: "before_char" | "after_char";
}

export interface WorldbookOptions {
  /** How many recent transcript messages participate in keyword scanning. */
  scanDepth: number;
  maxEntries: number;
  maxChars: number;
  /** Extra scan passes using selected entry content. 0 disables recursion. */
  recursionSteps?: number;
  /** Fallback for entries that do not set match_whole_words themselves. */
  matchWholeWords?: boolean;
}

interface RawEntry {
  name?: unknown;
  keys?: unknown;
  secondary_keys?: unknown;
  content?: unknown;
  enabled?: unknown;
  constant?: unknown;
  selective?: unknown;
  case_sensitive?: unknown;
  match_whole_words?: unknown;
  matchWholeWords?: unknown;
  priority?: unknown;
  insertion_order?: unknown;
  position?: unknown;
  extensions?: unknown;
}

interface CardLike {
  data?: {
    character_book?: {
      entries?: unknown;
    } | null;
  };
}

export type WorldbookSourceKind = "current" | "recent" | "recursion";

export interface WorldbookKeyHit {
  key: string;
  source: string;
  sourceKind: WorldbookSourceKind;
}

export interface WorldbookTraceMatch {
  entry: WorldbookEntry;
  round: number;
  constant: boolean;
  primary: WorldbookKeyHit[];
  secondary: WorldbookKeyHit[];
}

export interface WorldbookDrop {
  entry: WorldbookEntry;
  round: number;
  reason: string;
  match: WorldbookTraceMatch;
}

export interface WorldbookTrace {
  selected: WorldbookEntry[];
  matches: WorldbookTraceMatch[];
  dropped: WorldbookDrop[];
  usedChars: number;
  maxEntries: number;
  maxChars: number;
  scanDepth: number;
  recursionSteps: number;
  rounds: number;
}

export interface WorldbookContext {
  currentText: string;
  recentTexts: string[];
}

interface ScanSource {
  kind: WorldbookSourceKind;
  label: string;
  text: string;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function matchWholeWords(value: RawEntry): boolean | undefined {
  if (value.match_whole_words === true || value.matchWholeWords === true) return true;
  if (value.match_whole_words === false || value.matchWholeWords === false) return false;
  const extensions = record(value.extensions);
  if (extensions.match_whole_words === true || extensions.matchWholeWords === true) return true;
  if (extensions.match_whole_words === false || extensions.matchWholeWords === false) return false;
  return undefined;
}

/** Convert a Character Card book into the small subset this plugin understands. */
export function normalizeWorldbook(card: CardLike): WorldbookEntry[] {
  const raw = card.data?.character_book?.entries;
  if (!Array.isArray(raw)) return [];
  return (raw as RawEntry[])
    .map((entry): WorldbookEntry | null => {
      const content = typeof entry.content === "string" ? entry.content.trim() : "";
      if (content.length === 0) return null;
      const keys = stringArray(entry.keys);
      const secondaryKeys = stringArray(entry.secondary_keys);
      return {
        name:
          typeof entry.name === "string" && entry.name.trim().length > 0
            ? entry.name.trim()
            : content.slice(0, 24),
        keys,
        secondaryKeys,
        content,
        enabled: entry.enabled !== false,
        constant: entry.constant === true,
        selective: entry.selective === true || secondaryKeys.length > 0,
        caseSensitive: entry.case_sensitive === true,
        matchWholeWords: matchWholeWords(entry),
        priority: finiteNumber(entry.priority, 0),
        insertionOrder: finiteNumber(entry.insertion_order, 0),
        position: entry.position === "after_char" ? "after_char" : "before_char",
      };
    })
    .filter((entry): entry is WorldbookEntry => entry !== null && entry.enabled);
}

/**
 * Parse the plugin's cached `worldbook.json`. Older imports predate
 * `matchWholeWords`, so missing values default to false instead of being
 * rejected by the type guard.
 */
export function parseStoredWorldbook(value: unknown): WorldbookEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isWorldbookEntry(item)) return [];
    return [{ ...item, ...(typeof item.matchWholeWords === "boolean" ? { matchWholeWords: item.matchWholeWords } : {}) }];
  });
}

export function isWorldbookEntry(value: unknown): value is WorldbookEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    Array.isArray(entry.keys) &&
    entry.keys.every((key) => typeof key === "string") &&
    Array.isArray(entry.secondaryKeys) &&
    entry.secondaryKeys.every((key) => typeof key === "string") &&
    typeof entry.content === "string" &&
    typeof entry.enabled === "boolean" &&
    typeof entry.constant === "boolean" &&
    typeof entry.selective === "boolean" &&
    typeof entry.caseSensitive === "boolean" &&
    (typeof entry.matchWholeWords === "boolean" || entry.matchWholeWords === undefined) &&
    typeof entry.priority === "number" &&
    typeof entry.insertionOrder === "number" &&
    (entry.position === "before_char" || entry.position === "after_char")
  );
}

/** Select matching lore entries under a simple deterministic budget. */
export function selectWorldbook(
  entries: WorldbookEntry[],
  context: WorldbookContext,
  options: WorldbookOptions,
): WorldbookEntry[] {
  return selectWorldbookDetailed(entries, context, options).selected;
}

/**
 * Worldbook lite selection with an optional single extra scan pass.
 *
 * Recursion semantics intentionally differ from SillyTavern's "max recursion
 * steps": `recursionSteps` counts *extra* passes, so 0 disables recursion and
 * 1 means "scan selected content once more". Only entries that survive the
 * budget contribute to the recursion buffer, and the same maxEntries/maxChars
 * budget is shared across every pass.
 */
export function selectWorldbookDetailed(
  entries: WorldbookEntry[],
  context: WorldbookContext,
  options: WorldbookOptions,
): WorldbookTrace {
  const scanDepth = Math.max(0, Math.floor(options.scanDepth));
  const maxEntries = Math.max(0, Math.floor(options.maxEntries));
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const recursionSteps = Math.min(3, Math.max(0, Math.floor(options.recursionSteps ?? 0)));
  const recent = scanDepth === 0 ? [] : context.recentTexts.slice(-scanDepth);
  const sources: ScanSource[] = [
    { kind: "current", label: "当前消息", text: context.currentText },
    ...[...recent].reverse().map((text, index): ScanSource => ({
      kind: "recent",
      label: `最近第 ${index + 1} 条`,
      text,
    })),
  ];
  const selected: WorldbookEntry[] = [];
  const selectedIndexes = new Set<number>();
  const matches: WorldbookTraceMatch[] = [];
  const dropped: WorldbookDrop[] = [];
  let usedChars = 0;
  let rounds = 0;

  for (let round = 0; round <= recursionSteps; round += 1) {
    rounds = round + 1;
    const candidates: Array<{ index: number; match: WorldbookTraceMatch }> = [];
    for (const [index, entry] of entries.entries()) {
      if (!entry.enabled || selectedIndexes.has(index)) continue;
      const match = matchEntry(
        entry,
        sources,
        round,
        options.matchWholeWords === true,
      );
      if (match === null) continue;
      if (round > 0 && !hasRecursionHit(match)) continue;
      candidates.push({ index, match });
    }

    candidates.sort(
      (left, right) =>
        Number(right.match.constant) - Number(left.match.constant) ||
        right.match.entry.priority - left.match.entry.priority ||
        left.match.entry.insertionOrder - right.match.entry.insertionOrder ||
        left.match.entry.name.localeCompare(right.match.entry.name),
    );

    const nextSources: ScanSource[] = [];
    let selectedThisRound = 0;
    for (const { index, match } of candidates) {
      if (selected.length >= maxEntries) {
        dropped.push({
          entry: match.entry,
          round,
          reason: `条目上限（${maxEntries} 条）`,
          match,
        });
        continue;
      }
      const cost = match.entry.content.length;
      if (usedChars + cost > maxChars) {
        dropped.push({
          entry: match.entry,
          round,
          reason: `预算不足（需要 ${cost} 字，剩余 ${Math.max(0, maxChars - usedChars)} 字）`,
          match,
        });
        continue;
      }
      selected.push(match.entry);
      selectedIndexes.add(index);
      usedChars += cost;
      matches.push(match);
      selectedThisRound += 1;
      nextSources.push({
        kind: "recursion",
        label: `递归自「${match.entry.name}」`,
        text: match.entry.content,
      });
    }

    // Add recursion content after the whole round so scanning is not
    // order-dependent inside the same pass.
    sources.push(...nextSources);
    if (selectedThisRound === 0) break;
  }

  return {
    selected,
    matches,
    dropped,
    usedChars,
    maxEntries,
    maxChars,
    scanDepth,
    recursionSteps,
    rounds,
  };
}

function matchEntry(
  entry: WorldbookEntry,
  sources: ScanSource[],
  round: number,
  globalWholeWords: boolean,
): WorldbookTraceMatch | null {
  if (entry.constant) {
    return {
      entry,
      round,
      constant: true,
      primary: [],
      secondary: [],
    };
  }
  if (entry.keys.length === 0) return null;
  const wholeWords = entry.matchWholeWords ?? globalWholeWords;
  const primary = entry.keys
    .map((key) => findKeyHit(entry, key, sources, wholeWords))
    .filter((hit): hit is WorldbookKeyHit => hit !== null);
  if (primary.length === 0) return null;

  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return { entry, round, constant: false, primary, secondary: [] };
  }
  const secondary = entry.secondaryKeys
    .map((key) => findKeyHit(entry, key, sources, wholeWords))
    .filter((hit): hit is WorldbookKeyHit => hit !== null);
  if (secondary.length === 0) return null;
  return { entry, round, constant: false, primary, secondary };
}

function hasRecursionHit(match: WorldbookTraceMatch): boolean {
  return [...match.primary, ...match.secondary].some(
    (hit) => hit.sourceKind === "recursion",
  );
}

function findKeyHit(
  entry: WorldbookEntry,
  key: string,
  sources: ScanSource[],
  wholeWords: boolean,
): WorldbookKeyHit | null {
  for (const source of sources) {
    if (matchesKey(source.text, key, entry.caseSensitive, wholeWords)) {
      return { key, source: source.label, sourceKind: source.kind };
    }
  }
  return null;
}

function matchesKey(
  haystack: string,
  key: string,
  caseSensitive: boolean,
  wholeWords: boolean,
): boolean {
  const needle = caseSensitive ? key : key.toLowerCase();
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  if (needle.length === 0) return false;
  if (!wholeWords || !isAsciiWordKey(needle)) {
    return text.includes(needle);
  }
  const escaped = escapeRegExp(needle);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Only pure ASCII word-like keys get word-boundary matching. Multi-word keys
 * and CJK/mixed keys keep substring semantics, which is both closer to
 * SillyTavern and avoids breaking languages without spaces.
 */
function isAsciiWordKey(key: string): boolean {
  if (/\s/.test(key)) return false;
  return /^[A-Za-z0-9_]+(?:['-][A-Za-z0-9_]+)*$/.test(key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderWorldbook(entries: WorldbookEntry[]): string {
  if (entries.length === 0) return "";
  return ["[世界书]", ...entries.map((entry) => `- ${entry.content}`)].join("\n");
}

/** Human-readable trace for `!worldbook check`. */
export function formatWorldbookTrace(
  name: string,
  input: string,
  trace: WorldbookTrace,
): string {
  const lines: string[] = [
    `世界书：${name}（${trace.matches.length + trace.dropped.length} 条命中，扫描 ${trace.scanDepth} 条历史）`,
    `输入：${truncate(input.replace(/\s+/g, " ").trim(), 120)}`,
  ];
  for (let round = 0; round < trace.rounds; round += 1) {
    const roundMatches = trace.matches.filter((match) => match.round === round);
    const roundDrops = trace.dropped.filter((drop) => drop.round === round);
    if (roundMatches.length === 0 && roundDrops.length === 0) continue;
    lines.push(`第 ${round} 轮：`);
    for (const match of roundMatches) {
      lines.push(`- ${formatMatch(match)}`);
    }
    for (const drop of roundDrops) {
      lines.push(`- ${formatMatch(drop.match)} → 未选中：${drop.reason}`);
    }
  }
  if (lines.length === 2) lines.push("没有任何条目命中。");
  lines.push(
    `最终：${trace.selected.length}/${trace.maxEntries} 条，已用 ${trace.usedChars}/${trace.maxChars} 字`,
  );
  if (trace.selected.length === 0) {
    lines.push("（没有条目进入最终预算）");
  } else {
    for (const entry of trace.selected) {
      lines.push(`- ${entry.name}（${entry.position}）`);
    }
  }
  return lines.join("\n");
}

function formatMatch(match: WorldbookTraceMatch): string {
  if (match.constant) return `${match.entry.name} [常驻]`;
  const primary = match.primary
    .map((hit) => `「${hit.key}」← ${hit.source}`)
    .join("、");
  const secondary =
    match.secondary.length > 0
      ? `；次关键词 ${match.secondary.map((hit) => `「${hit.key}」← ${hit.source}`).join("、")}`
      : "";
  return `${match.entry.name} [p${match.entry.priority}] ${primary}${secondary}`;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
