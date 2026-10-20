import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison for short tokens. An empty expected token disables auth. */
export function tokenMatches(expected: string, actual: string | null): boolean {
  if (expected.length === 0) return true;
  if (actual === null) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== "string" || header.length === 0) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1]) return match[1];
  return header;
}
