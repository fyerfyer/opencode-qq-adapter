import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../../packages/roleplay/src/time.js";

describe("roleplay timestamps", () => {
  it("formats memory timestamps in local time without ISO markers", () => {
    const text = formatTimestamp(Date.UTC(2026, 9, 24, 7, 53));
    expect(text).toMatch(/^2026-10-24 \d{2}:53$/);
    expect(text).not.toContain("T");
    expect(text).not.toContain("Z");
  });
});
