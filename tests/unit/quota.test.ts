import { describe, expect, it } from "vitest";
import { localDay, QuotaService } from "../../src/policy/quota.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { makeTestConfig } from "../helpers/fakes.js";

function setup(now: () => number = Date.now) {
  const config = makeTestConfig({ projectPath: "/tmp" });
  config.security.rate_limit = { runs_per_hour: 10 };
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
  it("enforces the global hourly limit for users without an override", () => {
    const { config, quota } = setup();
    config.security.rate_limit = { runs_per_hour: 1 };
    quota.recordPrompt(20000, "demo");
    const denied = quota.check(20000, "demo");
    expect(denied).toMatchObject({ allowed: false, reason: "runs_per_hour" });
    expect(denied.message).toContain("每小时");
  });

  it("lets a user override the global hourly limit with a higher value", () => {
    const { config, quota } = setup();
    config.security.rate_limit = { runs_per_hour: 1 };
    config.users["20000"] = {
      role: "member",
      projects: ["demo"],
      write_projects: [],
      limits: { runs_per_hour: 10 },
    };
    for (let index = 0; index < 5; index += 1) quota.recordPrompt(20000, "demo");
    expect(quota.check(20000, "demo").allowed).toBe(true);
  });

  it("treats a null user hourly limit as unlimited", () => {
    const { config, quota } = setup();
    config.security.rate_limit = { runs_per_hour: 1 };
    config.users["20000"] = {
      role: "member",
      projects: ["demo"],
      write_projects: [],
      limits: { runs_per_hour: null },
    };
    for (let index = 0; index < 5; index += 1) quota.recordPrompt(20000, "demo");
    expect(quota.check(20000, "demo").allowed).toBe(true);
  });

  it("ignores the deprecated prompts-per-minute global limit", () => {
    const { config, quota } = setup();
    config.security.rate_limit = { prompts_per_minute: 1 };
    quota.recordPrompt(20000, "demo");
    quota.recordPrompt(20000, "demo");
    expect(quota.check(20000, "demo").allowed).toBe(true);
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

  it("keeps daily budgets active when the hourly limit is unlimited", () => {
    const { config, quota } = setup();
    config.users["20000"] = {
      role: "owner",
      projects: ["*"],
      write_projects: [],
      limits: { runs_per_hour: null, daily_cost_usd: 0.5 },
    };
    quota.recordRunUsage(20000, "demo", { inputTokens: 0, outputTokens: 0, costUsd: 0.6 });
    expect(quota.check(20000, "demo")).toMatchObject({ allowed: false, reason: "daily_cost" });
  });
});
