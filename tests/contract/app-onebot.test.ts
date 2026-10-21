import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig, waitFor } from "../helpers/fakes.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function startApp(
  agent: FakeAgent,
  mutate?: (config: ReturnType<typeof makeTestConfig>) => void,
) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-contract-"));
  const config = makeTestConfig({ projectPath });
  config.server.port = 0;
  mutate?.(config);
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, { logger, store, agent, onebot });
  await app.start();
  disposers.push(async () => {
    await app.stop();
    logger.flush?.();
  });
  return { app, config, onebot };
}

function messageEvent(id: number, text: string, userId = 20000): Record<string, unknown> {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 10000,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: id,
    user_id: userId,
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { user_id: userId, nickname: "Tester" },
  };
}

describe("Application + OneBot port contract", () => {
  it("replies pong to !ping and exposes healthy HTTP", async () => {
    const { app, onebot } = await startApp(new FakeAgent());
    onebot.emit(messageEvent(1, "!ping"));
    await waitFor(() => onebot.texts().includes("pong"), 3000, "pong");

    const response = await fetch(`http://127.0.0.1:${app.httpPort}/health`);
    expect(response.status).toBe(200);
    const health = (await response.json()) as {
      status: string;
      onebot: { connected: boolean; mode: string };
    };
    expect(health.onebot.connected).toBe(true);
    expect(health.onebot.mode).toBe("forward");
    expect(health.status).toBe("ok");
  });

  it("routes a prompt through the fake agent and sends the final text", async () => {
    const agent = new FakeAgent();
    agent.answer = "hello from fake agent";
    const { onebot } = await startApp(agent);
    onebot.emit(messageEvent(2, "please help"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("hello from fake agent")),
      3000,
      "final answer",
    );
    expect(agent.prompts[0]?.text).toBe("please help");
  });

  it("interrupts a running prompt with !stop", async () => {
    const agent = new FakeAgent();
    agent.autoComplete = false;
    const { app, onebot } = await startApp(agent);
    onebot.emit(messageEvent(3, "long running prompt"));
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt delivery");
    onebot.emit(messageEvent(4, "!stop"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已请求中断")),
      3000,
      "stop reply",
    );
    await waitFor(() => agent.interrupts.length === 1, 3000, "interrupt");
    await waitFor(
      () => app.conversations.status("private:20000").recentRuns[0]?.status === "interrupted",
      3000,
      "interrupted run",
    );
  });

  it("lists projects, switches project and resets the session", async () => {
    const agent = new FakeAgent();
    agent.answer = "session answer";
    const { app, onebot } = await startApp(agent);

    onebot.emit(messageEvent(5, "!projects"));
    await waitFor(() => onebot.texts().some((text) => text.includes("demo")), 3000, "projects");

    onebot.emit(messageEvent(6, "!use demo"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已切换到项目")),
      3000,
      "use project",
    );

    onebot.emit(messageEvent(7, "hello"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("session answer")),
      3000,
      "answer",
    );
    expect(app.conversations.getConversation("private:20000")?.sessionId).toMatch(/^ses_fake_/);

    onebot.emit(messageEvent(8, "!new"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已清除当前会话")),
      3000,
      "new session",
    );
    expect(app.conversations.getConversation("private:20000")?.sessionId).toBeNull();
  });

  it("asks for approval in QQ and applies the user's decision", async () => {
    const agent = new FakeAgent();
    agent.autoComplete = false;
    const { app, onebot } = await startApp(agent);
    onebot.emit(messageEvent(11, "please run the tests"));
    await waitFor(
      () => typeof app.conversations.getConversation("private:20000")?.sessionId === "string",
      3000,
      "session",
    );
    const sessionId = app.conversations.getConversation("private:20000")?.sessionId ?? "";

    agent.askPermission({
      id: "per_1",
      sessionId,
      action: "shell",
      resources: ["npm test"],
      save: [],
      message: "run tests",
      metadata: null,
    });
    await waitFor(
      () => onebot.texts().some((text) => text.includes("需要审批")),
      3000,
      "approval prompt",
    );

    onebot.emit(messageEvent(12, "1"));
    await waitFor(() => agent.permissionReplies.length === 1, 3000, "permission reply");
    expect(agent.permissionReplies[0]).toMatchObject({
      sessionId,
      requestId: "per_1",
      decision: "once",
    });
    expect(onebot.texts().some((text) => text.includes("已批准"))).toBe(true);

    agent.complete(sessionId);
    await waitFor(
      () => app.conversations.status("private:20000").recentRuns[0]?.status === "completed",
      3000,
      "completed run",
    );
  });

  it("rate limits prompts and records the rejection in the audit log", async () => {
    const { app, onebot } = await startApp(new FakeAgent(), (config) => {
      config.security.rate_limit = { prompts_per_minute: 1 };
    });
    onebot.emit(messageEvent(13, "first prompt"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("fake answer")),
      3000,
      "first answer",
    );
    onebot.emit(messageEvent(14, "second prompt"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("请求过于频繁")),
      3000,
      "rate limit",
    );
    expect(app.audit.listRecent(10).some((event) => event.action === "prompt.rejected")).toBe(true);
  });

  it("ignores unknown users silently but audits the denial", async () => {
    const { app, onebot } = await startApp(new FakeAgent());
    onebot.emit(messageEvent(9, "!ping", 99999));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onebot.sent).toHaveLength(0);
    expect(app.audit.listRecent(10)[0]).toMatchObject({
      actorQq: 99999,
      action: "access.denied",
    });
  });

  it("deduplicates repeated message IDs", async () => {
    const { onebot } = await startApp(new FakeAgent());
    onebot.emit(messageEvent(10, "!ping"));
    onebot.emit(messageEvent(10, "!ping"));
    await waitFor(
      () => onebot.texts().filter((text) => text === "pong").length === 1,
      3000,
      "one pong",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onebot.texts().filter((text) => text === "pong")).toHaveLength(1);
  });
});
