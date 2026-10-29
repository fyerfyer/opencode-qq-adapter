export type SelectiveLogic = "and_any" | "not_any" | "and_all" | "not_all";

export interface WorldbookEntry {
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  /** SillyTavern selective logic for secondary keys. Defaults to and_any. */
  selectiveLogic?: SelectiveLogic;
  caseSensitive: boolean;
  matchWholeWords?: boolean;
  priority: number;
  insertionOrder: number;
  position: "before_char" | "after_char";
  /** Trigger probability 0-100. 100/undefined means always. */
  probability?: number;
  /** Stays active for N messages after activation, ignoring keys/probability. */
  sticky?: number;
  /** Cannot activate for N messages after the sticky period ends. */
  cooldown?: number;
  /** Cannot activate before the chat has at least N messages. */
  delay?: number;
}

/** Per-chat timed-effect memory, keyed by entry name. */
export interface WorldbookEffectState {
  /** Message count at activation. */
  activatedAt: number;
  sticky: number;
  cooldown: number;
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
  /** Current message count of the chat; enables delay/sticky/cooldown. */
  messageCount?: number;
  /** Mutable per-chat timed-effect state, keyed by entry name. */
  effectState?: Map<string, WorldbookEffectState>;
  /** Random source for probability rolls. */
  random?: () => number;
}

interface RawEntry {
  name?: unknown;
  keys?: unknown;
  secondary_keys?: unknown;
  content?: unknown;
  enabled?: unknown;
  constant?: unknown;
  selective?: unknown;
  selective_logic?: unknown;
  selectiveLogic?: unknown;
  case_sensitive?: unknown;
  match_whole_words?: unknown;
  matchWholeWords?: unknown;
  priority?: unknown;
  insertion_order?: unknown;
  position?: unknown;
  probability?: unknown;
  sticky?: unknown;
  cooldown?: unknown;
  delay?: unknown;
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
  /** Active via sticky timed effect, without a keyword match. */
  sticky?: boolean;
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

const SELECTIVE_LOGIC_NAMES: SelectiveLogic[] = ["and_any", "not_any", "and_all", "not_all"];

function selectiveLogic(value: unknown): SelectiveLogic | undefined {
  if (typeof value === "string" && (SELECTIVE_LOGIC_NAMES as string[]).includes(value)) {
    return value as SelectiveLogic;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return SELECTIVE_LOGIC_NAMES[value];
  }
  return undefined;
}

function optionalPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function optionalCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const count = Math.floor(value);
  return count > 0 ? count : undefined;
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
      const extensions = record(entry.extensions);
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
        selectiveLogic:
          selectiveLogic(entry.selectiveLogic) ??
          selectiveLogic(entry.selective_logic) ??
          selectiveLogic(extensions.selectiveLogic) ??
          selectiveLogic(extensions.selective_logic),
        probability: optionalPercent(entry.probability ?? extensions.probability),
        sticky: optionalCount(entry.sticky ?? extensions.sticky),
        cooldown: optionalCount(entry.cooldown ?? extensions.cooldown),
        delay: optionalCount(entry.delay ?? extensions.delay),
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
  const messageCount = Math.max(0, Math.floor(options.messageCount ?? 0));
  const random = options.random ?? Math.random;

  for (let round = 0; round <= recursionSteps; round += 1) {
    rounds = round + 1;
    const candidates: Array<{ index: number; match: WorldbookTraceMatch }> = [];
    for (const [index, entry] of entries.entries()) {
      if (!entry.enabled || selectedIndexes.has(index)) continue;
      const effect = options.effectState?.get(entry.name);
      const elapsed = effect === undefined ? null : messageCount - effect.activatedAt;
      if (effect !== undefined && elapsed !== null && elapsed >= 1 && elapsed <= effect.sticky) {
        // Sticky: stays active without a keyword match, ignoring probability.
        candidates.push({
          index,
          match: { entry, round, constant: false, sticky: true, primary: [], secondary: [] },
        });
        continue;
      }
      if (effect !== undefined && elapsed !== null && elapsed <= effect.sticky + effect.cooldown) {
        continue; // Cooldown: cannot activate at all.
      }
      if (entry.delay !== undefined && messageCount < entry.delay) continue;
      const match = matchEntry(
        entry,
        sources,
        round,
        options.matchWholeWords === true,
      );
      if (match === null) continue;
      if (round > 0 && !hasRecursionHit(match)) continue;
      const probability = entry.probability ?? 100;
      if (probability < 100 && random() * 100 >= probability) {
        dropped.push({ entry, round, reason: `概率未命中（${probability}%）`, match });
        continue;
      }
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
      if (
        match.sticky !== true &&
        options.effectState !== undefined &&
        ((match.entry.sticky ?? 0) > 0 || (match.entry.cooldown ?? 0) > 0)
      ) {
        options.effectState.set(match.entry.name, {
          activatedAt: messageCount,
          sticky: match.entry.sticky ?? 0,
          cooldown: match.entry.cooldown ?? 0,
        });
      }
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
  // SillyTavern selective logic: AND ANY (default), AND ALL, NOT ANY, NOT ALL.
  switch (entry.selectiveLogic ?? "and_any") {
    case "and_all":
      if (secondary.length < entry.secondaryKeys.length) return null;
      break;
    case "not_any":
      if (secondary.length > 0) return null;
      break;
    case "not_all":
      if (secondary.length === entry.secondaryKeys.length) return null;
      break;
    default:
      if (secondary.length === 0) return null;
      break;
  }
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
  // SillyTavern-style regex keys: /pattern/flags. Flags are the regex's own;
  // caseSensitive and wholeWords only apply to plaintext keys.
  const regex = parseRegexKey(key);
  if (regex !== null) return regex.test(haystack);
  const needle = caseSensitive ? key : key.toLowerCase();
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  if (needle.length === 0) return false;
  if (!wholeWords || !isAsciiWordKey(needle)) {
    return text.includes(needle);
  }
  const escaped = escapeRegExp(needle);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

const REGEX_CACHE = new Map<string, RegExp | null>();

function parseRegexKey(key: string): RegExp | null {
  const parsed = /^\/(.+)\/([a-z]*)$/.exec(key);
  if (parsed === null) return null;
  const cached = REGEX_CACHE.get(key);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(parsed[1] ?? "", parsed[2] ?? "");
  } catch {
    compiled = null;
  }
  if (REGEX_CACHE.size < 500) REGEX_CACHE.set(key, compiled);
  return compiled;
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
  if (match.sticky === true) return `${match.entry.name} [黏性生效]`;
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
