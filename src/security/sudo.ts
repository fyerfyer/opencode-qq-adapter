import type { AppConfig } from "../config/schema.js";
import { verifyTotp } from "./totp.js";

export interface SudoOptions {
  now?: () => number;
}

/**
 * Short-lived owner elevation for dangerous bridge commands. This is separate
 * from OpenCode permissions: it only gates bridge-side administration commands.
 */
export class SudoService {
  readonly #config: AppConfig["security"]["admin_2fa"];
  readonly #now: () => number;
  readonly #grants = new Map<number, number>();
  readonly #attempts = new Map<number, { count: number; resetAt: number }>();

  constructor(config: AppConfig["security"]["admin_2fa"], options: SudoOptions = {}) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  get windowSeconds(): number {
    return this.#config.window_seconds;
  }

  verify(actorQq: number, code: string): boolean {
    if (!this.#config.enabled) return false;
    const now = this.#now();
    const attempts = this.#attempts.get(actorQq);
    if (attempts !== undefined && attempts.resetAt > now && attempts.count >= 5) return false;
    const valid = verifyTotp(this.#config.totp_secret, code, now, {
      periodSeconds: this.#config.period_seconds,
      digits: this.#config.digits,
      window: 1,
    });
    if (valid) {
      this.#grants.set(actorQq, now + this.#config.window_seconds * 1000);
      this.#attempts.delete(actorQq);
      return true;
    }
    this.#attempts.set(actorQq, {
      count: attempts !== undefined && attempts.resetAt > now ? attempts.count + 1 : 1,
      resetAt: attempts !== undefined && attempts.resetAt > now ? attempts.resetAt : now + 60_000,
    });
    return false;
  }

  isActive(actorQq: number): boolean {
    if (!this.#config.enabled) return true;
    const expiresAt = this.#grants.get(actorQq);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.#now()) {
      this.#grants.delete(actorQq);
      return false;
    }
    return true;
  }

  remainingSeconds(actorQq: number): number {
    if (!this.#config.enabled) return 0;
    const expiresAt = this.#grants.get(actorQq);
    if (expiresAt === undefined) return 0;
    return Math.max(0, Math.ceil((expiresAt - this.#now()) / 1000));
  }

  revoke(actorQq: number): void {
    this.#grants.delete(actorQq);
  }
}
