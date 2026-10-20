import { describe, expect, it } from "vitest";
import { markdownToPlain, splitMessage } from "../../src/qq/text.js";

describe("QQ text formatting", () => {
  it("strips common markdown but preserves code fences", () => {
    const input = [
      "# Title",
      "",
      "This is **bold**, *italic*, [a link](https://example.com) and `code`.",
      "",
      "```ts",
      "const x = **1**;",
      "```",
    ].join("\n");
    const output = markdownToPlain(input);
    expect(output).toContain("Title");
    expect(output).toContain("This is bold, italic, a link (https://example.com) and `code`.");
    expect(output).toContain("const x = **1**;");
    expect(output).not.toContain("# Title");
  });

  it("does not split short messages", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits on paragraph boundaries", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
    const chunks = splitMessage(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80 + 8)).toBe(true);
    expect(chunks.join("\n").replaceAll("\n", "")).toBe(text.replaceAll("\n", ""));
  });

  it("balances code fences across chunks", () => {
    const text = [
      "```ts",
      ...Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`),
      "```",
    ].join("\n");
    const chunks = splitMessage(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.split("\n").filter((line) => line.trimStart().startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
  });

  it("hard-splits a single enormous line", () => {
    const text = "x".repeat(500);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(5);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it("keeps CJK text intact when possible", () => {
    const text = "这是一个很长的中文句子。".repeat(20);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});
