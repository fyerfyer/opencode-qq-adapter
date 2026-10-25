const MAX_TERMS = 32;

const ENGLISH_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "should",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

export interface QueryTerms {
  terms: string[];
  /** True when the query contains CJK text too short for the trigram index. */
  hasShortCjk: boolean;
}

/**
 * Extract searchable terms from a natural-language query.
 *
 * FTS5's trigram tokenizer indexes 3-character windows and cannot index
 * shorter CJK runs. CJK runs are therefore expanded into overlapping trigrams;
 * Latin/digit words pass through. Short CJK runs are reported so callers can
 * fall back to LIKE.
 */
export function extractQueryTerms(input: string): QueryTerms {
  const normalized = input.normalize("NFKC").trim();
  if (normalized.length === 0) return { terms: [], hasShortCjk: false };

  const terms: string[] = [];
  const seen = new Set<string>();
  let hasShortCjk = false;

  const push = (term: string): void => {
    const value = term.trim();
    if (value.length === 0) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (terms.length < MAX_TERMS) terms.push(value);
  };

  for (const match of normalized.matchAll(/\p{Script=Han}+|[\p{L}\p{N}_-]+/gu)) {
    const token = match[0];
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token];
      if (chars.length < 3) {
        hasShortCjk = true;
        continue;
      }
      for (let index = 0; index + 3 <= chars.length; index += 1) {
        push(chars.slice(index, index + 3).join(""));
      }
      continue;
    }
    const lower = token.toLowerCase();
    if (lower.length < 2 || ENGLISH_STOPWORDS.has(lower)) continue;
    push(token);
  }

  return { terms, hasShortCjk };
}

/** Build an FTS5 MATCH expression from OR-joined quoted terms. */
export function buildFtsQuery(input: string): string | null {
  const { terms } = extractQueryTerms(input);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

/** Quote a complete query as an exact FTS phrase. */
export function buildPhraseQuery(input: string): string | null {
  const value = input.trim();
  if (value.length === 0) return null;
  return `"${value.replace(/"/g, '""')}"`;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
