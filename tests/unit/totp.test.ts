import { describe, expect, it } from "vitest";
import { decodeBase32, generateTotp, verifyTotp } from "../../src/security/totp.js";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    expect(decodeBase32("JBSWY3DPEHPK3PXP").toString("hex")).toBe("48656c6c6f21deadbeef");
    expect(generateTotp(RFC_SECRET, 59_000, { digits: 8 })).toBe("94287082");
    expect(generateTotp(RFC_SECRET, 59_000, { digits: 6 })).toBe("287082");
  });

  it("accepts the current code and one adjacent time step", () => {
    const now = 1_700_000_000_000;
    const code = generateTotp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 90_000)).toBe(false);
  });

  it("rejects malformed codes", () => {
    expect(verifyTotp(RFC_SECRET, "12345", 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", 59_000)).toBe(false);
  });
});
