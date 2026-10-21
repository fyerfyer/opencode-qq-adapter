import { createHmac, timingSafeEqual } from "node:crypto";

export interface TotpOptions {
  periodSeconds?: number;
  digits?: number;
  /** Number of time steps accepted before/after the current step. */
  window?: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function normalizeBase32(secret: string): string {
  return secret.replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase();
}

export function decodeBase32(secret: string): Buffer {
  const normalized = normalizeBase32(secret);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("TOTP secret is not valid Base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error("TOTP secret is empty");
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (HMAC-SHA1), compatible with common authenticator apps. */
export function generateTotp(
  secret: string,
  timestampMs: number,
  options: TotpOptions = {},
): string {
  const period = options.periodSeconds ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor(timestampMs / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function verifyTotp(
  secret: string,
  code: string,
  timestampMs: number,
  options: TotpOptions = {},
): boolean {
  const normalized = code.replace(/\s/g, "");
  const digits = options.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  const period = options.periodSeconds ?? 30;
  const window = options.window ?? 1;
  const expected = Buffer.from(normalized);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = generateTotp(secret, timestampMs + offset * period * 1000, {
      periodSeconds: period,
      digits,
    });
    if (timingSafeEqual(Buffer.from(candidate), expected)) return true;
  }
  return false;
}
