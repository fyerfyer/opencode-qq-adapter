import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;

interface TokenPayload {
  v: 1;
  id: string;
  exp: number;
}

export interface PluginUiTokenOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Short-lived HMAC capability for plugin UI static assets. The token only
 * grants read access to one plugin's packaged UI; it never carries a session
 * or CSRF token.
 */
export class PluginUiTokenSigner {
  readonly #secret: Buffer;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(secret: Uint8Array, options: PluginUiTokenOptions = {}) {
    if (secret.length < 16) throw new Error("plugin UI token secret must be at least 16 bytes");
    this.#secret = Buffer.from(secret);
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  sign(pluginId: string): string {
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`invalid plugin id: ${pluginId}`);
    const payload: TokenPayload = {
      v: 1,
      id: pluginId,
      exp: this.#now() + this.#ttlMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${this.#sign(encoded)}`;
  }

  verify(token: string): { pluginId: string } | null {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!this.#matches(encoded, signature)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (payload === null || typeof payload !== "object") return null;
    const value = payload as Partial<TokenPayload>;
    if (value.v !== 1) return null;
    if (typeof value.id !== "string" || !PLUGIN_ID.test(value.id)) return null;
    if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null;
    if (value.exp < this.#now()) return null;
    return { pluginId: value.id };
  }

  #sign(encoded: string): string {
    return createHmac("sha256", this.#secret).update(encoded).digest("base64url");
  }

  #matches(encoded: string, signature: string): boolean {
    const expected = Buffer.from(this.#sign(encoded));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
