import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../../src/domain/approval.js";
import { SqliteStore } from "../../src/store/sqlite.js";

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "01TESTAPPROVAL000000000000",
    shortId: "ABCD1234",
    runId: "run-1",
    chatKey: "private:20000",
    actorQq: 20000,
    projectId: "demo",
    sessionId: "ses_1",
    permissionId: "per_1",
    action: "shell",
    resources: ["git push origin main"],
    message: "run a command",
    status: "pending",
    requestedAt: 1000,
    expiresAt: 2000,
    repliedAt: null,
    repliedBy: null,
    decision: null,
    qqMessageId: "9001",
    ...overrides,
  };
}

describe("SqliteStore M2 repositories", () => {
  it("stores conversation actor and finds conversations by session", () => {
    const store = new SqliteStore(":memory:");
    store.conversations.upsert({
      chatKey: "private:20000",
      projectId: "demo",
      workspaceId: null,
      sessionId: "ses_1",
      actorQq: 20000,
      agent: null,
      model: null,
      createdAt: 1,
      lastActiveAt: 2,
    });
    expect(store.conversations.findBySession("ses_1")?.actorQq).toBe(20000);
    expect(store.conversations.get("private:20000")?.actorQq).toBe(20000);
    store.close();
  });

  it("persists approvals and resolves pending items by session or QQ message", () => {
    const store = new SqliteStore(":memory:");
    store.approvals.create(approval());
    expect(store.approvals.getByPermission("ses_1", "per_1")?.shortId).toBe("ABCD1234");
    expect(store.approvals.findPendingByChat("private:20000")).toHaveLength(1);
    expect(store.approvals.findPendingBySession("ses_1")).toHaveLength(1);
    expect(store.approvals.findPendingByMessage("private:20000", "9001")?.id).toBe(
      "01TESTAPPROVAL000000000000",
    );

    store.approvals.update("01TESTAPPROVAL000000000000", {
      status: "approved",
      repliedAt: 1500,
      repliedBy: 20000,
      decision: "once",
    });
    const record = store.approvals.get("01TESTAPPROVAL000000000000");
    expect(record).toMatchObject({ status: "approved", decision: "once", repliedBy: 20000 });
    expect(store.approvals.findPendingByChat("private:20000")).toHaveLength(0);
    store.close();
  });

  it("records audit events without requiring prompt content", () => {
    const store = new SqliteStore(":memory:");
    store.audit.record({
      ts: 100,
      actorQq: 20000,
      chatKey: "private:20000",
      projectId: "demo",
      workspaceId: null,
      action: "prompt.rejected",
      detail: { reason: "rate_limited" },
    });
    const events = store.audit.listRecent(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorQq: 20000,
      action: "prompt.rejected",
      detail: { reason: "rate_limited" },
    });
    store.close();
  });

  it("tracks daily usage and rate events", () => {
    const store = new SqliteStore(":memory:");
    store.usage.recordPrompt("2026-10-21", 20000, "demo");
    store.usage.addRunUsage("2026-10-21", 20000, "demo", {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.002,
    });
    store.usage.recordEvent(1000, 20000, "demo", "prompt");
    store.usage.recordEvent(2000, 20000, "demo", "prompt");

    const daily = store.usage.getDaily("2026-10-21", 20000, "demo");
    expect(daily).toMatchObject({
      prompts: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.002,
    });
    expect(store.usage.countEvents(20000, "prompt", 0)).toBe(2);
    expect(store.usage.pruneEvents(1500)).toBe(1);
    store.close();
  });

  it("stores workspace locks, renews leases and recovers them", () => {
    const store = new SqliteStore(":memory:");
    store.workspaces.ensure({
      id: "shared:demo",
      projectId: "demo",
      kind: "shared",
      path: "/tmp/demo",
      branch: null,
      ownerChatKey: null,
      status: "idle",
      lockedByRunId: null,
      leaseExpiresAt: null,
      createdAt: 1,
      lastUsedAt: 1,
    });

    expect(store.workspaces.tryLock("shared:demo", "run-1", "private:1", 1000, 5000)).toBe(true);
    expect(store.workspaces.tryLock("shared:demo", "run-2", "private:2", 1000, 5000)).toBe(false);
    expect(store.workspaces.renew("shared:demo", "run-1", 9000)).toBe(true);
    expect(store.workspaces.get("shared:demo")?.leaseExpiresAt).toBe(9000);
    expect(store.workspaces.releaseExpired(9001)).toBe(1);
    expect(store.workspaces.get("shared:demo")?.status).toBe("idle");

    expect(store.workspaces.tryLock("shared:demo", "run-3", "private:3", 1000, 5000)).toBe(true);
    expect(store.workspaces.recoverLocks(2000)).toBe(1);
    expect(store.workspaces.get("shared:demo")?.status).toBe("idle");
    store.close();
  });
});
