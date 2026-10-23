import { createHash, randomBytes } from "node:crypto";
import type { AdminSessionRecord } from "../domain/admin.js";
import type { StorePort } from "../ports/store.js";
import { generatePassword, hashPassword, verifyPassword } from "./password.js";

export const ADMIN_USERNAME = "admin";
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

export interface AdminBootstrap {
  created: boolean;
  username: string;
  /** Present only when a new account was created by this process. */
  password?: string;
}

export interface AdminRequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type AdminLoginResult =
  | {
      ok: true;
      token: string;
      csrfToken: string;
      expiresAt: number;
      username: string;
      mustChangePassword: boolean;
    }
  | {
      ok: false;
      reason: "invalid_password" | "rate_limited";
      retryAfterMs?: number;
    };

export interface AdminAuthOptions {
  store: StorePort;
  sessionHours: number;
  loginAttempts: number;
  initialPassword?: string;
}

interface LoginBucket {
  failures: number;
  resetAt: number;
}

/**
 * Single-admin authentication with scrypt password hashes, opaque session
 * tokens, CSRF tokens, and a small in-memory login throttle.
 *
 * The database only stores token hashes; the browser keeps the raw token in an
 * HttpOnly cookie. Sessions survive bridge restarts until they expire.
 */
export class AdminAuth {
  readonly #store: StorePort;
  #sessionHours: number;
  #loginAttempts: number;
  readonly #initialPassword: string | undefined;
  readonly #buckets = new Map<string, LoginBucket>();

  constructor(options: AdminAuthOptions) {
    this.#store = options.store;
    this.#sessionHours = options.sessionHours;
    this.#loginAttempts = options.loginAttempts;
    this.#initialPassword = options.initialPassword;
  }

  updateSettings(sessionHours: number, loginAttempts: number): void {
    this.#sessionHours = sessionHours;
    this.#loginAttempts = loginAttempts;
  }

  async start(): Promise<AdminBootstrap> {
    const now = Date.now();
    this.#store.admin.pruneSessions(now);
    const existing = this.#store.admin.getUser(ADMIN_USERNAME);
    if (existing !== null) {
      return { created: false, username: ADMIN_USERNAME };
    }
    const generated = this.#initialPassword === undefined || this.#initialPassword.length === 0;
    const password = generated ? generatePassword() : (this.#initialPassword as string);
    const passwordHash = await hashPassword(password);
    this.#store.admin.createUser({
      username: ADMIN_USERNAME,
      passwordHash,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    });
    return {
      created: true,
      username: ADMIN_USERNAME,
      ...(generated ? { password } : {}),
    };
  }

  async login(password: string, meta: AdminRequestMeta): Promise<AdminLoginResult> {
    const key = meta.ip ?? "unknown";
    const now = Date.now();
    const bucket = this.#bucket(key, now);
    if (bucket.failures >= this.#loginAttempts) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterMs: Math.max(0, bucket.resetAt - now),
      };
    }

    const user = this.#store.admin.getUser(ADMIN_USERNAME);
    const valid = user !== null && (await verifyPassword(password, user.passwordHash));
    if (!valid) {
      bucket.failures += 1;
      return { ok: false, reason: "invalid_password" };
    }

    this.#buckets.delete(key);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    const expiresAt = createdAt + this.#sessionHours * 60 * 60 * 1000;
    this.#store.admin.createSession({
      tokenHash: hashToken(token),
      username: user.username,
      csrfToken,
      createdAt,
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      ok: true,
      token,
      csrfToken,
      expiresAt,
      username: user.username,
      mustChangePassword: user.mustChangePassword,
    };
  }

  account(): { username: string; mustChangePassword: boolean } | null {
    const user = this.#store.admin.getUser(ADMIN_USERNAME);
    return user === null
      ? null
      : { username: user.username, mustChangePassword: user.mustChangePassword };
  }

  session(token: string | undefined): AdminSessionRecord | null {
    if (token === undefined || token.length === 0) return null;
    const tokenHash = hashToken(token);
    const session = this.#store.admin.getSession(tokenHash);
    if (session === null) return null;
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.#store.admin.deleteSession(tokenHash);
      return null;
    }
    // Sliding expiry, renewed at most once per minute to avoid a write per API call.
    if (now - session.lastSeenAt > 60_000) {
      const expiresAt = now + this.#sessionHours * 60 * 60 * 1000;
      this.#store.admin.touchSession(tokenHash, now, expiresAt);
      return { ...session, lastSeenAt: now, expiresAt };
    }
    return session;
  }

  logout(token: string | undefined): void {
    if (token === undefined || token.length === 0) return;
    this.#store.admin.deleteSession(hashToken(token));
  }

  async changePassword(
    currentPassword: string,
    nextPassword: string,
    token: string,
    meta: AdminRequestMeta,
  ): Promise<{ ok: true; csrfToken: string } | { ok: false; reason: string }> {
    const user = this.#store.admin.getUser(ADMIN_USERNAME);
    if (user === null) return { ok: false, reason: "管理员账号不存在。" };
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return { ok: false, reason: "当前密码不正确。" };
    }
    if (nextPassword.length < 10) {
      return { ok: false, reason: "新密码至少需要 10 个字符。" };
    }
    if (nextPassword === currentPassword) {
      return { ok: false, reason: "新密码不能与当前密码相同。" };
    }
    const passwordHash = await hashPassword(nextPassword);
    this.#store.admin.updatePassword(ADMIN_USERNAME, passwordHash, false, Date.now());
    // Keep the current browser signed in with a fresh CSRF token; every other
    // browser session is revoked.
    this.#store.admin.deleteSessions();
    const now = Date.now();
    const csrfToken = randomBytes(24).toString("base64url");
    this.#store.admin.createSession({
      tokenHash: hashToken(token),
      username: user.username,
      csrfToken,
      createdAt: now,
      expiresAt: now + this.#sessionHours * 60 * 60 * 1000,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return { ok: true, csrfToken };
  }

  #bucket(key: string, now: number): LoginBucket {
    const existing = this.#buckets.get(key);
    if (existing !== undefined && existing.resetAt > now) return existing;
    const bucket = { failures: 0, resetAt: now + LOGIN_WINDOW_MS };
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > 1000) {
      for (const [bucketKey, value] of this.#buckets) {
        if (value.resetAt <= now) this.#buckets.delete(bucketKey);
      }
    }
    return bucket;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
