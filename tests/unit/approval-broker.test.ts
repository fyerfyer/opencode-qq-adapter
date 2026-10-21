import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalBroker } from "../../src/approval/broker.js";
import { buildLogger } from "../../src/observability/logger.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { MessageSender } from "../../src/qq/sender.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import {
  FakeAgent,
  FakeOneBot,
  makeIncomingMessage,
  makeTestConfig,
  waitFor,
} from "../helpers/fakes.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup(
  options: { timeoutMs?: number; groupShared?: boolean; startBroker?: boolean } = {},
) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-approval-"));
  const config = makeTestConfig({ projectPath });
  config.opencode.permission_timeout_ms = options.timeoutMs ?? 5000;
  const baseUser = config.users["20000"];
  if (baseUser === undefined) throw new Error("test config is missing user 20000");
  config.users["10001"] = { ...baseUser, role: "owner", projects: ["*"] };
  config.users["20000"] = { ...baseUser, role: "admin", projects: ["*"] };
  config.users["20001"] = { role: "member", projects: ["demo"] };
  if (options.groupShared) {
    config.groups["30001"] = {
      enabled: true,
      mode: "shared",
      allowed_users: ["10001", "20000", "20001"],
      projects: ["demo"],
    };
    config.projects.demo = {
      ...config.projects.demo,
      allowed_groups: ["30001"],
    };
  }

  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const policy = new PolicyEngine(config);
  const broker = new ApprovalBroker({ config, store, agent, sender, policy, logger });
  if (options.startBroker !== false) broker.start();
  disposers.push(async () => {
    await broker.stop();
    store.close();
    logger.flush?.();
  });
  return { config, store, agent, onebot, sender, policy, broker };
}

async function seedSession(
  store: SqliteStore,
  options: { chatKey?: string; actorQq?: number; sessionId?: string } = {},
) {
  const chatKey = options.chatKey ?? "private:20000";
  const sessionId = options.sessionId ?? "ses_1";
  store.conversations.upsert({
    chatKey,
    projectId: "demo",
    sessionId,
    actorQq: options.actorQq ?? 20000,
    agent: null,
    model: null,
    createdAt: 1,
    lastActiveAt: 2,
  });
  store.runs.create({
    id: "run-1",
    chatKey,
    projectId: "demo",
    sessionId,
    actorQq: options.actorQq ?? 20000,
    status: "running",
    startedAt: 1,
    finishedAt: null,
    stopReason: null,
    error: null,
    usageJson: null,
  });
  return { chatKey, sessionId };
}

function firstPending(broker: ApprovalBroker, chatKey: string) {
  const approval = broker.pending(chatKey)[0];
  if (approval === undefined) throw new Error(`no pending approval in ${chatKey}`);
  return approval;
}

function approvalMessage(chatKey = "private:20000", replyToId?: string) {
  if (chatKey.startsWith("group:")) {
    const [, groupId, userId] = chatKey.split(":");
    return makeIncomingMessage({
      userId: Number(userId ?? 10001),
      chat: {
        type: "group",
        userId: Number(userId ?? 10001),
        groupId: Number(groupId),
        chatKey,
      },
      text: "1",
      ...(replyToId ? { replyToId } : {}),
    });
  }
  const userId = Number(chatKey.split(":")[1] ?? 20000);
  return makeIncomingMessage({
    userId,
    text: "1",
    ...(replyToId ? { replyToId } : {}),
  });
}

describe("ApprovalBroker", () => {
  it("turns a permission.asked event into a QQ prompt and persists it", async () => {
    const { store, agent, onebot, broker } = await setup();
    await seedSession(store);

    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["git push origin main"],
      save: ["git push *"],
      message: "needs approval",
      metadata: null,
    });

    await waitFor(
      () => onebot.texts().some((text) => text.includes("需要审批")),
      2000,
      "approval prompt",
    );
    const prompt = onebot.texts().find((text) => text.includes("需要审批")) ?? "";
    expect(prompt).toContain("shell");
    expect(prompt).toContain("git push origin main");
    expect(prompt).toContain("!approve");

    const pending = broker.pending("private:20000");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      permissionId: "per_1",
      sessionId: "ses_1",
      action: "shell",
      status: "pending",
    });
    expect(pending[0]?.shortId).toHaveLength(8);
    expect(store.runs.get("run-1")?.status).toBe("waiting_permission");
  });

  it("approves once when the initiating user sends the approval id", async () => {
    const { store, agent, onebot, broker } = await setup();
    await seedSession(store);
    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(() => broker.pending("private:20000").length === 1, 2000, "pending");

    const approval = firstPending(broker, "private:20000");
    const result = await broker.resolve(approvalMessage(), approval.shortId.toLowerCase(), "once");

    expect(result.ok).toBe(true);
    expect(agent.permissionReplies).toEqual([
      { sessionId: "ses_1", requestId: "per_1", decision: "once" },
    ]);
    expect(store.approvals.get(approval.id)?.status).toBe("approved");
    expect(store.runs.get("run-1")?.status).toBe("running");
    expect(onebot.texts().some((text) => text.includes("已批准"))).toBe(true);
  });

  it("does not let another private chat resolve someone else's approval", async () => {
    const { store, agent, onebot, broker } = await setup();
    await seedSession(store);
    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(() => broker.pending("private:20000").length === 1, 2000, "pending");
    const approval = firstPending(broker, "private:20000");

    const result = await broker.resolve(
      makeIncomingMessage({ userId: 20001 }),
      approval.shortId,
      "once",
    );

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(agent.permissionReplies).toHaveLength(0);
    expect(store.approvals.get(approval.id)?.status).toBe("pending");
    expect(onebot.texts().some((text) => text.includes("未找到"))).toBe(true);
  });

  it("accepts numeric replies and resolves the approval quoted by the user", async () => {
    const { store, agent, onebot, broker } = await setup();
    await seedSession(store);
    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(() => onebot.texts().some((text) => text.includes("需要审批")), 2000, "prompt");
    const approval = firstPending(broker, "private:20000");
    await waitFor(
      () => store.approvals.get(approval.id)?.qqMessageId !== null,
      2000,
      "approval message id",
    );
    const promptMessageId = store.approvals.get(approval.id)?.qqMessageId;
    expect(promptMessageId).not.toBeNull();

    const handled = await broker.handleTextReply(
      approvalMessage("private:20000", promptMessageId ?? ""),
    );

    expect(handled).toBe(true);
    expect(agent.permissionReplies[0]).toMatchObject({ decision: "once" });
    expect(store.approvals.get(approval.id)?.status).toBe("approved");
  });

  it("auto-rejects requests after the configured timeout", async () => {
    const { store, agent, onebot, broker } = await setup({ timeoutMs: 50 });
    await seedSession(store);
    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(() => broker.pending("private:20000").length === 1, 2000, "pending");
    const approval = firstPending(broker, "private:20000");

    await waitFor(
      () => store.approvals.get(approval.id)?.status === "expired",
      2000,
      "expired approval",
    );
    expect(agent.permissionReplies[0]).toMatchObject({
      requestId: "per_1",
      decision: "reject",
    });
    await waitFor(
      () => onebot.texts().some((text) => text.includes("超时")),
      2000,
      "timeout notice",
    );
  });

  it("rejects every pending approval for a stopped chat", async () => {
    const { store, agent, broker } = await setup();
    await seedSession(store);
    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(() => broker.pending("private:20000").length === 1, 2000, "pending");

    await broker.rejectChat("private:20000", "stop_command");

    expect(agent.permissionReplies[0]).toMatchObject({ decision: "reject" });
    expect(broker.pending("private:20000")).toHaveLength(0);
    expect(store.approvals.listRecent("private:20000", 1)[0]?.status).toBe("rejected");
  });

  it("does not resurrect runs that were interrupted during bridge recovery", async () => {
    const { store, broker } = await setup({ startBroker: false });
    await seedSession(store);
    store.runs.finish("run-1", {
      status: "interrupted",
      finishedAt: Date.now(),
      stopReason: "bridge_restart",
    });
    store.approvals.create({
      id: "01RESTARTAPPROVAL000000000",
      shortId: "RESTART1",
      runId: "run-1",
      chatKey: "private:20000",
      actorQq: 20000,
      projectId: "demo",
      sessionId: "ses_1",
      permissionId: "per_restart",
      action: "shell",
      resources: ["npm test"],
      message: null,
      status: "pending",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      repliedAt: null,
      repliedBy: null,
      decision: null,
      qqMessageId: null,
    });

    broker.start();
    await waitFor(
      () => store.approvals.get("01RESTARTAPPROVAL000000000")?.status === "cancelled",
      2000,
      "stale approval cancelled",
    );
    expect(store.runs.get("run-1")?.status).toBe("interrupted");
  });

  it("attributes child-session permissions to the parent conversation", async () => {
    const { store, agent, onebot, broker } = await setup();
    await seedSession(store);
    agent.emit({
      type: "session.created",
      sessionId: "ses_child",
      data: { sessionID: "ses_child", parentID: "ses_1" },
      receivedAt: Date.now(),
    });
    agent.askPermission({
      id: "per_child",
      sessionId: "ses_child",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(
      () => onebot.texts().some((text) => text.includes("需要审批")),
      2000,
      "child approval prompt",
    );
    const approval = firstPending(broker, "private:20000");
    const result = await broker.resolve(approvalMessage(), approval.shortId, "once");
    expect(result.ok).toBe(true);
    expect(agent.permissionReplies[0]).toMatchObject({
      sessionId: "ses_child",
      requestId: "per_child",
      decision: "once",
    });
  });

  it("ignores permissions for sessions it does not own instead of rejecting them", async () => {
    const { store, agent, broker } = await setup();
    agent.askPermission({
      id: "per_other",
      sessionId: "ses_tui",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(
      () => store.audit.listRecent(10).some((event) => event.action === "approval.ignored"),
      2000,
      "orphan audit",
    );
    expect(agent.permissionReplies).toHaveLength(0);
    expect(broker.pending("private:20000")).toHaveLength(0);
  });

  it("only lets owner/admin approve shared-group runs", async () => {
    const { store, agent, broker } = await setup({ groupShared: true });
    await seedSession(store, { chatKey: "group:30001", actorQq: 20000 });
    agent.askPermission({
      id: "per_1",
      sessionId: "ses_1",
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: null,
      metadata: null,
    });
    await waitFor(() => broker.pending("group:30001").length === 1, 2000, "pending");
    const approval = firstPending(broker, "group:30001");

    const member = await broker.resolve(
      makeIncomingMessage({
        userId: 20001,
        chat: { type: "group", userId: 20001, groupId: 30001, chatKey: "group:30001" },
      }),
      approval.shortId,
      "once",
    );
    expect(member).toMatchObject({ ok: false, reason: "forbidden" });

    const owner = await broker.resolve(
      makeIncomingMessage({
        userId: 10001,
        chat: { type: "group", userId: 10001, groupId: 30001, chatKey: "group:30001" },
      }),
      approval.shortId,
      "once",
    );
    expect(owner.ok).toBe(true);
    expect(agent.permissionReplies).toHaveLength(1);
  });
});
