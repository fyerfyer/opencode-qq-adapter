import { describe, expect, it } from "vitest";
import {
  buildFtsQuery,
  buildPhraseQuery,
  extractQueryTerms,
} from "../../packages/roleplay/src/retrieval.js";

describe("roleplay transcript query helpers", () => {
  it("expands CJK runs into overlapping trigrams", () => {
    const result = extractQueryTerms("我想吃白米饭");
    expect(result.hasShortCjk).toBe(false);
    expect(result.terms).toEqual(["我想吃", "想吃白", "吃白米", "白米饭"]);
    expect(buildFtsQuery("我想吃白米饭")).toBe('"我想吃" OR "想吃白" OR "吃白米" OR "白米饭"');
  });

  it("reports short CJK runs for LIKE fallback", () => {
    expect(extractQueryTerms("海边")).toMatchObject({ hasShortCjk: true, terms: [] });
    expect(buildFtsQuery("海边")).toBeNull();
  });

  it("keeps latin words and drops stopwords", () => {
    const result = extractQueryTerms("what do I like about RAG");
    expect(result.terms).toContain("RAG");
    expect(result.terms).not.toContain("what");
    expect(result.terms).not.toContain("about");
  });

  it("escapes quoted phrases", () => {
    expect(buildPhraseQuery('say "hi"')).toBe('"say ""hi"""');
  });
});
