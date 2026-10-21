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

async function startApp() {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-management-"));
  const config = makeTestConfig({ projectPath });
  config.server.port = 0;
  config.qq.progress_delay_ms = 60_000;
  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, { logger, store, agent, onebot });
  await app.start();
  disposers.push(async () => {
    await app.stop();
    logger.flush?.();
  });
  return { app, agent, onebot };
}

let nextId = 100;
function messageEvent(text: string): Record<string, unknown> {
  const id = nextId++;
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 10000,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: id,
    user_id: 20000,
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { user_id: 20000, nickname: "Tester" },
  };
}

describe("QQ management commands", () => {
  it("switches model/agent for a new session and restores an old session", async () => {
    const { app, agent, onebot } = await startApp();
    agent.answer = "ok";

    onebot.emit(messageEvent("!use demo"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已切换到项目")),
      3000,
      "project",
    );

    onebot.emit(messageEvent("!model fake/model-b"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已切换模型：fake/model-b")),
      3000,
      "model switch",
    );
    expect(app.conversations.getConversation("private:20000")?.model).toBe("fake/model-b");

    onebot.emit(messageEvent("!agent build"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已切换 agent：build")),
      3000,
      "agent switch",
    );

    onebot.emit(messageEvent("hello"));
    await waitFor(() => onebot.texts().some((text) => text.includes("ok")), 3000, "answer");
    expect(agent.sessionInputs[0]?.model).toBe("fake/model-b");
    expect(agent.sessionInputs[0]?.agent).toBe("build");

    const firstSession = app.conversations.getConversation("private:20000")?.sessionId;
    expect(firstSession).toBeTruthy();

    onebot.emit(messageEvent("!new"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已清除当前会话")),
      3000,
      "new session",
    );
    onebot.emit(messageEvent("second"));
    await waitFor(
      () => onebot.texts().filter((text) => text.includes("ok")).length >= 2,
      3000,
      "second answer",
    );
    const secondSession = app.conversations.getConversation("private:20000")?.sessionId;
    expect(secondSession).toBeTruthy();
    expect(secondSession).not.toBe(firstSession);

    onebot.emit(messageEvent("!sessions"));
    await waitFor(() => onebot.texts().some((text) => text.includes("最近会话")), 3000, "sessions");

    onebot.emit(messageEvent(`!switch ${String(firstSession).slice(0, 12)}`));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已切换会话")),
      3000,
      "switch session",
    );
    expect(app.conversations.getConversation("private:20000")?.sessionId).toBe(firstSession);
  });

  it("restricts model switching in a shared group to owner/admin", async () => {
    const { app, onebot } = await startApp();
    app.config.users["30000"] = { role: "member", projects: ["demo"] };
    app.config.groups["90000"] = {
      enabled: true,
      mode: "shared",
      require_mention: false,
      allowed_users: ["30000"],
      projects: ["demo"],
    };
    onebot.emit({
      ...messageEvent("!model fake/model-a"),
      message_type: "group",
      group_id: 90000,
      user_id: 30000,
      sender: { user_id: 30000, nickname: "Member" },
    });
    await waitFor(
      () => onebot.texts().some((text) => text.includes("shared 群只有 owner/admin")),
      3000,
      "shared restriction",
    );
  });
});
