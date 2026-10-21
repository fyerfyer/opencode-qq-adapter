import { describe, expect, it } from "vitest";
import { localDay, QuotaService } from "../../src/policy/quota.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { makeTestConfig } from "../helpers/fakes.js";

function setup(now: () => number = Date.now) {
  const config = makeTestConfig({ projectPath: "/tmp" });
  config.security.rate_limit = { prompts_per_minute: 2, runs_per_hour: 10 };
  config.security.budgets = {
    daily_cost_usd_per_user: 1,
    daily_tokens_per_user: 1000,
    daily_cost_usd_per_project: 2,
  };
  const store = new SqliteStore(":memory:");
  const quota = new QuotaService({
    config,
    store,
    now,
    day: () => localDay(now()),
  });
  return { config, store, quota };
}

describe("QuotaService", () => {
  it("enforces prompts-per-minute after recording accepted prompts", () => {
    const { quota } = setup();
    expect(quota.check(20000, "demo").allowed).toBe(true);
    quota.recordPrompt(20000, "demo");
    quota.recordPrompt(20000, "demo");
    const denied = quota.check(20000, "demo");
    expect(denied).toMatchObject({ allowed: false, reason: "prompts_per_minute" });
    expect(denied.message).toContain("每分钟");
  });

  it("enforces runs-per-hour independently from prompts-per-minute", () => {
    const { config, quota } = setup();
    config.security.rate_limit = { prompts_per_minute: 100, runs_per_hour: 1 };
    quota.recordPrompt(20000, "demo");
    expect(quota.check(20000, "demo")).toMatchObject({
      allowed: false,
      reason: "runs_per_hour",
    });
  });

  it("rejects when the actor daily cost budget is exhausted", () => {
    const { quota } = setup();
    quota.recordRunUsage(20000, "demo", { inputTokens: 1, outputTokens: 1, costUsd: 1.01 });
    expect(quota.check(20000, "demo")).toMatchObject({ allowed: false, reason: "daily_cost" });
  });

  it("rejects when the actor daily token budget is exhausted", () => {
    const { quota } = setup();
    quota.recordRunUsage(20000, "demo", { inputTokens: 900, outputTokens: 200, costUsd: 0 });
    expect(quota.check(20000, "demo")).toMatchObject({ allowed: false, reason: "daily_tokens" });
  });

  it("rejects when the shared project budget is exhausted", () => {
    const { quota } = setup();
    quota.recordRunUsage(10001, "demo", { inputTokens: 0, outputTokens: 0, costUsd: 1.5 });
    quota.recordRunUsage(20000, "demo", { inputTokens: 0, outputTokens: 0, costUsd: 0.6 });
    expect(quota.check(20000, "demo")).toMatchObject({
      allowed: false,
      reason: "project_daily_cost",
    });
  });

  it("allows user limits to tighten but not loosen global limits", () => {
    let now = Date.now();
    const { config, quota } = setup(() => now);
    config.users["20000"] = {
      role: "owner",
      projects: ["*"],
      limits: { prompts_per_minute: 1, daily_cost_usd: 0.5 },
    };
    quota.recordPrompt(20000, "demo");
    expect(quota.check(20000, "demo")).toMatchObject({
      allowed: false,
      reason: "prompts_per_minute",
    });
    now += 61_000;
    quota.recordRunUsage(20000, "demo", { inputTokens: 0, outputTokens: 0, costUsd: 0.6 });
    expect(quota.check(20000, "demo")).toMatchObject({ allowed: false, reason: "daily_cost" });
  });
});
