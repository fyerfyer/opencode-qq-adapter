import { isChatProjectId } from "../chat/project.js";
import type { AppConfig } from "../config/schema.js";
import type { DailyUsage } from "../domain/audit.js";
import type { StorePort, UsageDelta } from "../ports/store.js";

export type QuotaDenyReason =
  | "runs_per_hour"
  | "daily_cost"
  | "daily_tokens"
  | "project_daily_cost";

export interface QuotaDecision {
  allowed: boolean;
  reason: QuotaDenyReason | null;
  message: string | null;
}

export interface QuotaOptions {
  config: AppConfig;
  store: StorePort;
  now?: () => number;
  day?: (now: number) => string;
}

const HOUR_MS = 60 * 60 * 1000;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Local calendar day used for daily budgets. */
export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Resolve the effective hourly request cap.
 *
 * A user-level value overrides the global default. `null` means unlimited;
 * an omitted value inherits `security.rate_limit.runs_per_hour`.
 */
export function hourlyLimit(config: AppConfig, actorQq: number): number | null {
  const userLimit = config.users[String(actorQq)]?.limits?.runs_per_hour;
  if (userLimit !== undefined) return userLimit;
  return config.security.rate_limit.runs_per_hour ?? null;
}

/** Number of accepted requests in the rolling hour ending at `now`. */
export function hourlyRequestCount(store: StorePort, actorQq: number, now = Date.now()): number {
  return store.usage.countEvents(actorQq, "run", now - HOUR_MS);
}

/**
 * Enforces per-user rate limits and daily cost/token budgets.
 *
 * Budgets are cost-control, not a security boundary. The security boundary
 * remains the OpenCode permission ruleset.
 */
export class QuotaService {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #now: () => number;
  readonly #day: (now: number) => string;
  #lastPrune = 0;

  constructor(options: QuotaOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#day = options.day ?? localDay;
  }

  check(actorQq: number, projectId: string): QuotaDecision {
    const now = this.#now();
    const user = this.#config.users[String(actorQq)];
    const runsPerHour = hourlyLimit(this.#config, actorQq);
    if (runsPerHour !== null && hourlyRequestCount(this.#store, actorQq, now) >= runsPerHour) {
      return deny("runs_per_hour", `请求过于频繁：每小时最多 ${runsPerHour} 次请求，请稍后再试。`);
    }

    const day = this.#day(now);
    const actorUsage = this.#store.usage.getActorDaily(day, actorQq);
    const dailyCost = minLimit(
      this.#config.security.budgets.daily_cost_usd_per_user,
      user?.limits?.daily_cost_usd,
    );
    if (dailyCost !== undefined && actorUsage.costUsd >= dailyCost) {
      return deny(
        "daily_cost",
        `今日成本预算已用完（$${actorUsage.costUsd.toFixed(4)} / $${dailyCost}）。`,
      );
    }
    const dailyTokens = minLimit(
      this.#config.security.budgets.daily_tokens_per_user,
      user?.limits?.daily_tokens,
    );
    const usedTokens = actorUsage.inputTokens + actorUsage.outputTokens;
    if (dailyTokens !== undefined && usedTokens >= dailyTokens) {
      return deny("daily_tokens", `今日 token 预算已用完（${usedTokens} / ${dailyTokens}）。`);
    }

    const projectCost = this.#config.security.budgets.daily_cost_usd_per_project;
    if (projectCost !== undefined && !isChatProjectId(projectId)) {
      const projectUsage = this.#store.usage.getProjectDaily(day, projectId);
      if (projectUsage.costUsd >= projectCost) {
        return deny(
          "project_daily_cost",
          `项目 '${projectId}' 今日成本预算已用完（$${projectUsage.costUsd.toFixed(4)} / $${projectCost}）。`,
        );
      }
    }

    return { allowed: true, reason: null, message: null };
  }

  recordPrompt(actorQq: number, projectId: string): void {
    const now = this.#now();
    const day = this.#day(now);
    this.#store.usage.recordPrompt(day, actorQq, projectId);
    this.#store.usage.recordEvent(now, actorQq, projectId, "run");
    this.#prune(now);
  }

  recordRunUsage(actorQq: number, projectId: string, usage: UsageDelta): void {
    this.#store.usage.addRunUsage(this.#day(this.#now()), actorQq, projectId, usage);
  }

  usageToday(
    actorQq: number,
    projectId: string,
  ): {
    actor: DailyUsage;
    project: DailyUsage;
  } {
    const day = this.#day(this.#now());
    return {
      actor: this.#store.usage.getActorDaily(day, actorQq),
      project: this.#store.usage.getProjectDaily(day, projectId),
    };
  }

  #prune(now: number): void {
    if (now - this.#lastPrune < HOUR_MS) return;
    this.#lastPrune = now;
    this.#store.usage.pruneEvents(now - EVENT_RETENTION_MS);
  }
}

function minLimit(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) return undefined;
  return Math.min(...defined);
}

function deny(reason: QuotaDenyReason, message: string): QuotaDecision {
  return { allowed: false, reason, message };
}
