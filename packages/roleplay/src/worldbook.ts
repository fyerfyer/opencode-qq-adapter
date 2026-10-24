export interface WorldbookEntry {
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  caseSensitive: boolean;
  priority: number;
  insertionOrder: number;
  position: "before_char" | "after_char";
}

export interface WorldbookOptions {
  /** How many recent transcript messages participate in keyword scanning. */
  scanDepth: number;
  maxEntries: number;
  maxChars: number;
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
  priority?: unknown;
  insertion_order?: unknown;
  position?: unknown;
}

interface CardLike {
  data?: {
    character_book?: {
      entries?: unknown;
    } | null;
  };
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
        priority: finiteNumber(entry.priority, 0),
        insertionOrder: finiteNumber(entry.insertion_order, 0),
        position: entry.position === "after_char" ? "after_char" : "before_char",
      };
    })
    .filter((entry): entry is WorldbookEntry => entry !== null && entry.enabled);
}

export interface WorldbookContext {
  currentText: string;
  recentTexts: string[];
}

function entryMatches(entry: WorldbookEntry, haystack: string): boolean {
  if (entry.constant) return true;
  if (entry.keys.length === 0) return false;
  const text = entry.caseSensitive ? haystack : haystack.toLowerCase();
  const primary = entry.keys.some((key) =>
    text.includes(entry.caseSensitive ? key : key.toLowerCase()),
  );
  if (!primary) return false;
  if (!entry.selective || entry.secondaryKeys.length === 0) return true;
  return entry.secondaryKeys.some((key) =>
    text.includes(entry.caseSensitive ? key : key.toLowerCase()),
  );
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
  const depth = Math.max(0, options.scanDepth);
  const recent = depth === 0 ? [] : context.recentTexts.slice(-depth);
  const haystack = [...recent, context.currentText].join("\n");
  if (haystack.trim().length === 0) {
    return entries.filter((entry) => entry.constant).slice(0, 1);
  }
  const matches = entries
    .filter((entry) => entry.enabled && entryMatches(entry, haystack))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.insertionOrder - right.insertionOrder ||
        left.name.localeCompare(right.name),
    );

  const selected: WorldbookEntry[] = [];
  let used = 0;
  const maxEntries = Math.max(0, options.maxEntries);
  const maxChars = Math.max(0, options.maxChars);
  for (const entry of matches) {
    if (selected.length >= maxEntries) break;
    if (used + entry.content.length > maxChars) continue;
    selected.push(entry);
    used += entry.content.length;
  }
  return selected;
}

export function renderWorldbook(entries: WorldbookEntry[]): string {
  if (entries.length === 0) return "";
  return ["[世界书]", ...entries.map((entry) => `- ${entry.content}`)].join("\n");
}
