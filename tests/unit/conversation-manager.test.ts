import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../../src/conversation/manager.js";
import { AuditTrail } from "../../src/observability/audit.js";
import { buildLogger } from "../../src/observability/logger.js";
import { MessageSender } from "../../src/qq/sender.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
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

async function setup(maxQueued = 3) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-manager-"));
  const config = makeTestConfig({ projectPath, maxQueued });
  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const workspaces = new WorkspaceManager({ config, store, logger });
  const audit = new AuditTrail(store, logger);
  const manager = new ConversationManager(config, store, agent, sender, logger, {
    workspaces,
    audit,
  });
  disposers.push(async () => {
    await manager.shutdown();
    store.close();
    logger.flush?.();
  });
  return { projectPath, config, store, agent, onebot, manager };
}

function addTestAgent(agent: FakeAgent, id: string, model: string | null): void {
  agent.agents.push({
    id,
    name: id,
    description: null,
    mode: "primary",
    model,
    hidden: false,
  });
}

async function waitForCompletedRun(manager: ConversationManager, chatKey: string): Promise<void> {
  await waitFor(() => manager.status(chatKey).activeRun === null, 3000, "run completion");
}

describe("ConversationManager", () => {
  it("creates a session, runs a prompt and sends the final answer", async () => {
    const { store, agent, onebot, manager } = await setup();
    const message = makeIncomingMessage({ text: "say hello" });
    const result = await manager.submit(message, "demo");
    expect(result.accepted).toBe(true);

    await waitFor(
      () => onebot.texts().some((text) => text.includes("fake answer")),
      3000,
      "answer",
    );
    const conversation = store.conversations.get("private:20000");
    expect(conversation?.projectId).toBe("demo");
    expect(conversation?.sessionId).toMatch(/^ses_fake_/);
    expect(agent.prompts[0]?.text).toBe("say hello");
    const status = manager.status("private:20000");
    expect(status.recentRuns[0]?.status).toBe("completed");
    expect(status.activeRun).toBeNull();

    const finished = store.audit.listRecent(20).find((record) => record.action === "run.finished");
    expect(finished?.detail).toMatchObject({
      status: "completed",
      agent: "qq-code",
      model: "fake/model-a",
    });
  });

  it("prefers the selected agent's frontmatter model over project and OpenCode defaults", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    config.projects.demo.model = "fake/model-b";
    config.opencode.default_model = "fake/model-a";
    addTestAgent(agent, "qq-code", "fake/model-c");

    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.sessionInputs.length === 1, 3000, "session creation");
    await waitForCompletedRun(manager, "private:20000");

    expect(agent.sessionInputs[0]).toMatchObject({ agent: "qq-code" });
    expect(agent.sessionInputs[0]?.model ?? null).toBeNull();
    expect(store.conversations.get("private:20000")?.model).toBeNull();
  });

  it("passes an explicit model override to a new session and stores it", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    config.projects.demo.model = "fake/model-b";
    addTestAgent(agent, "qq-code", "fake/model-c");
    expect(manager.setProject("private:20000", "demo", 20000).ok).toBe(true);
    expect((await manager.setModel("private:20000", "fake/model-a")).ok).toBe(true);

    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.sessionInputs.length === 1, 3000, "session creation");

    expect(agent.sessionInputs[0]).toMatchObject({ agent: "qq-code", model: "fake/model-a" });
    expect(store.conversations.get("private:20000")?.model).toBe("fake/model-a");
  });

  it("does not overwrite an explicit conversation model with the session model at run completion", async () => {
    const { store, agent, manager } = await setup();
    agent.autoComplete = false;
    expect(manager.setProject("private:20000", "demo", 20000).ok).toBe(true);
    expect((await manager.setModel("private:20000", "fake/model-b")).ok).toBe(true);
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");

    const sessionId = store.conversations.get("private:20000")?.sessionId ?? "";
    const session = agent.sessions.get(sessionId);
    expect(session).toBeDefined();
    if (session !== undefined) session.model = "derived/model-x";
    agent.complete(sessionId);
    await waitForCompletedRun(manager, "private:20000");

    expect(store.conversations.get("private:20000")?.model).toBe("fake/model-b");
  });

  it("switches a live session to the new agent's frontmatter model when no explicit model is set", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    config.projects.demo.model = "fake/model-b";
    addTestAgent(agent, "qq-code", "fake/model-a");
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");
    await waitForCompletedRun(manager, "private:20000");
    const sessionId = store.conversations.get("private:20000")?.sessionId;

    addTestAgent(agent, "review", "fake/model-c");
    const result = await manager.setAgent("private:20000", "review");
    expect(result.ok).toBe(true);
    expect(agent.switchedAgents).toEqual([{ sessionId, agent: "review" }]);
    expect(agent.switchedModels).toEqual([{ sessionId, model: "fake/model-c" }]);
    expect(store.conversations.get("private:20000")).toMatchObject({
      agent: "review",
      model: null,
    });
  });

  it("applies the new agent's frontmatter model from setPreferences", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    config.projects.demo.model = "fake/model-b";
    addTestAgent(agent, "qq-code", "fake/model-a");
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");
    await waitForCompletedRun(manager, "private:20000");
    const sessionId = store.conversations.get("private:20000")?.sessionId;

    addTestAgent(agent, "review", "fake/model-c");
    const result = await manager.setPreferences("private:20000", { agent: "review" });
    expect(result.ok).toBe(true);
    expect(agent.switchedAgents).toEqual([{ sessionId, agent: "review" }]);
    expect(agent.switchedModels).toEqual([{ sessionId, model: "fake/model-c" }]);
    expect(store.conversations.get("private:20000")).toMatchObject({
      agent: "review",
      model: null,
    });
  });

  it("keeps an explicit conversation model when switching agents", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    addTestAgent(agent, "qq-code", "fake/model-a");
    expect(manager.setProject("private:20000", "demo", 20000).ok).toBe(true);
    expect((await manager.setModel("private:20000", "fake/model-b")).ok).toBe(true);
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");
    await waitForCompletedRun(manager, "private:20000");
    const sessionId = store.conversations.get("private:20000")?.sessionId;

    addTestAgent(agent, "review", "fake/model-c");
    const result = await manager.setAgent("private:20000", "review");
    expect(result.ok).toBe(true);
    expect(agent.switchedAgents).toEqual([{ sessionId, agent: "review" }]);
    expect(agent.switchedModels).toEqual([]);
    expect(store.conversations.get("private:20000")).toMatchObject({
      agent: "review",
      model: "fake/model-b",
    });
  });

  it("applies admin agent/model preferences to the current session", async () => {
    const { store, agent, manager } = await setup();
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");
    await waitFor(() => manager.status("private:20000").activeRun === null, 3000, "run completion");

    const result = await manager.setPreferences("private:20000", {
      model: "fake/model-b",
      agent: "build",
    });
    expect(result.ok).toBe(true);
    expect(agent.switchedModels).toEqual([
      { sessionId: store.conversations.get("private:20000")?.sessionId, model: "fake/model-b" },
    ]);
    expect(agent.switchedAgents).toEqual([
      { sessionId: store.conversations.get("private:20000")?.sessionId, agent: "build" },
    ]);
    expect(store.conversations.get("private:20000")).toMatchObject({
      model: "fake/model-b",
      agent: "build",
    });
  });

  it("interrupts the active run and suppresses the final answer", async () => {
    const { store, agent, onebot, manager } = await setup();
    agent.autoComplete = false;
    await manager.submit(makeIncomingMessage({ text: "long task" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 2000, "prompt");

    const result = await manager.stop("private:20000");
    expect(result.stopped).toBe(true);
    await waitFor(
      () => manager.status("private:20000").recentRuns[0]?.status === "interrupted",
      3000,
      "interrupted run",
    );
    expect(agent.interrupts).toHaveLength(1);
    expect(onebot.texts().some((text) => text.includes("fake answer"))).toBe(false);
    expect(store.runs.listRecent("private:20000", 1)[0]?.stopReason).toBe("user");
  });

  it("rejects prompts beyond the queue limit", async () => {
    const { agent, onebot, manager } = await setup(1);
    agent.autoComplete = false;
    const first = await manager.submit(makeIncomingMessage({ id: "1", text: "first" }), "demo");
    const second = await manager.submit(makeIncomingMessage({ id: "2", text: "second" }), "demo");
    const third = await manager.submit(makeIncomingMessage({ id: "3", text: "third" }), "demo");
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.queued).toBe(true);
    expect(third.accepted).toBe(false);
    expect(onebot.texts().some((text) => text.includes("队列已满"))).toBe(true);
    await manager.stop("private:20000");
  });

  it("passes the permission ruleset to new sessions and refreshes it before each prompt", async () => {
    const { store, agent, manager } = await setup();
    const permissions = [
      { action: "shell" as const, resource: "*" as const, effect: "ask" as const },
      { action: "external_directory" as const, resource: "*" as const, effect: "deny" as const },
    ];

    await manager.submit(makeIncomingMessage({ id: "perm-1", text: "first" }), "demo", permissions);
    await waitFor(() => agent.prompts.length === 1, 3000, "first prompt");
    await waitFor(() => agent.permissionUpdates.length === 1, 3000, "permission update");

    expect(agent.sessionInputs[0]?.permissions).toEqual(permissions);
    expect(agent.permissionUpdates[0]).toEqual({
      sessionId: store.conversations.get("private:20000")?.sessionId,
      permissions,
    });
  });

  it("applies an agent default model to live sessions without pinning the conversation", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");
    await waitFor(() => manager.status("private:20000").activeRun === null, 3000, "run completion");

    const conversation = store.conversations.get("private:20000");
    expect(conversation?.sessionId).not.toBeNull();
    const result = await manager.applyAgentDefaultModel("qq-code", "fake/model-b");
    expect(result.updated).toBe(1);
    expect(agent.switchedModels).toEqual([
      { sessionId: conversation?.sessionId, model: "fake/model-b" },
    ]);
    expect(store.conversations.get("private:20000")?.model).toBeNull();
  });

  it("does not apply an agent default model to a conversation with an explicit model", async () => {
    const { config, store, agent, manager } = await setup();
    config.projects.demo.agent = "qq-code";
    await manager.submit(makeIncomingMessage({ text: "hello" }), "demo");
    await waitFor(() => manager.status("private:20000").activeRun === null, 3000, "run completion");
    await manager.setModel("private:20000", "fake/model-a");
    const sessionId = store.conversations.get("private:20000")?.sessionId;

    const result = await manager.applyAgentDefaultModel("qq-code", "fake/model-b");
    expect(result.updated).toBe(0);
    expect(agent.switchedModels).toEqual([{ sessionId, model: "fake/model-a" }]);
  });

  it("serializes runs from different chats that share a workspace", async () => {
    const { config, agent, manager } = await setup();
    config.users["20001"] = { role: "owner", projects: ["*"] };
    agent.autoComplete = false;

    await manager.submit(
      makeIncomingMessage({
        id: "a",
        userId: 20000,
        chat: { type: "private", userId: 20000, chatKey: "private:20000" },
        text: "first",
      }),
      "demo",
    );
    await waitFor(() => agent.prompts.length === 1, 3000, "first prompt");
    await manager.submit(
      makeIncomingMessage({
        id: "b",
        userId: 20001,
        chat: { type: "private", userId: 20001, chatKey: "private:20001" },
        text: "second",
      }),
      "demo",
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(agent.prompts).toHaveLength(1);
    expect(manager.workspaceStatus("demo").workspace?.status).toBe("locked");

    const firstSession = manager.status("private:20000").activeRun?.sessionId ?? "";
    agent.complete(firstSession);
    await waitFor(() => agent.prompts.length === 2, 3000, "second prompt after release");
    const secondSession = manager.status("private:20001").activeRun?.sessionId ?? "";
    agent.complete(secondSession);
    await waitFor(
      () => manager.workspaceStatus("demo").workspace?.status === "idle",
      3000,
      "workspace released",
    );
  });

  it("reports a failed run to QQ", async () => {
    const { agent, onebot, manager } = await setup();
    agent.failWith = "model exploded";
    await manager.submit(makeIncomingMessage({ text: "fail please" }), "demo");
    await waitFor(
      () => onebot.texts().some((text) => text.includes("处理失败")),
      3000,
      "failure message",
    );
    expect(manager.status("private:20000").recentRuns[0]?.status).toBe("failed");
  });

  it("does not report completion when the wait fails while the session is still running", async () => {
    const { agent, onebot, manager } = await setup();
    agent.waitError = new Error("Headers Timeout Error");
    await manager.submit(makeIncomingMessage({ text: "still working" }), "demo");

    await waitFor(
      () => onebot.texts().some((text) => text.includes("仍在运行")),
      3000,
      "still running failure",
    );
    expect(manager.status("private:20000").recentRuns[0]?.status).toBe("failed");
    expect(onebot.texts().some((text) => text.includes("任务已完成"))).toBe(false);
  });

  it("rejects new prompts while an OpenCode reload is in progress", async () => {
    const { manager } = await setup();
    const gate = manager.beginMaintenance();
    expect(gate.ok).toBe(true);

    const rejected = await manager.submit(makeIncomingMessage({ text: "during reload" }), "demo");
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toContain("重载");

    manager.endMaintenance();
    const accepted = await manager.submit(makeIncomingMessage({ text: "after reload" }), "demo");
    expect(accepted.accepted).toBe(true);
  });

  it("refuses to start a maintenance gate while a run is active", async () => {
    const { agent, manager } = await setup();
    agent.autoComplete = false;
    await manager.submit(makeIncomingMessage({ text: "hold" }), "demo");
    await waitFor(() => manager.activeRuns() === 1, 3000, "active run");

    const gate = manager.beginMaintenance();
    expect(gate.ok).toBe(false);
    expect(gate.activeRuns).toBe(1);
    await manager.stop("private:20000");
  });
});
