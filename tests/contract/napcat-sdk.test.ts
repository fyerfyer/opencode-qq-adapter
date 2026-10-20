import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeNapCatServer } from "../helpers/fake-napcat.js";
import { FakeAgent, makeTestConfig, waitFor } from "../helpers/fakes.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function startApp(agent: FakeAgent) {
  const server = new FakeNapCatServer();
  await server.start("test-token");
  disposers.push(async () => server.stop());

  const projectPath = await mkdtemp(join(tmpdir(), "qq-sdk-contract-"));
  const config = makeTestConfig({ projectPath });
  config.server.port = 0;
  config.onebot.url = server.url;
  config.onebot.access_token = "test-token";
  const store = new SqliteStore(":memory:");
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, { logger, store, agent });
  await app.start();
  disposers.push(async () => {
    await app.stop();
    logger.flush?.();
  });
  await waitFor(
    () => server.actions.some((action) => action.action === "get_login_info"),
    5000,
    "NapCat login probe",
  );
  return { app, server };
}

function messageEvent(id: number, text: string): Record<string, unknown> {
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

function actionText(params: Record<string, unknown>): string {
  const message = params.message as Array<{ type: string; data?: { text?: string } }> | undefined;
  return (message ?? [])
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.data?.text ?? "")
    .join("");
}

describe("node-napcat-ts adapter over a fake NapCat websocket", () => {
  it("connects, handles !ping and reports healthy", async () => {
    const { app, server } = await startApp(new FakeAgent());
    server.sendEvent(messageEvent(1, "!ping"));
    await waitFor(
      () => server.actions.some((action) => action.action === "send_private_msg"),
      5000,
      "pong action",
    );
    const send = server.actions.find((action) => action.action === "send_private_msg");
    expect(actionText(send?.params ?? {})).toBe("pong");

    const response = await fetch(`http://127.0.0.1:${app.httpPort}/health`);
    const health = (await response.json()) as {
      status: string;
      onebot: { connected: boolean; mode: string; selfId: number | null };
      opencode: { healthy: boolean };
    };
    expect(health.onebot).toMatchObject({ connected: true, mode: "forward", selfId: 10000 });
    expect(health.opencode.healthy).toBe(true);
    expect(health.status).toBe("ok");
  });

  it("runs a prompt through the SDK and sends the final answer", async () => {
    const agent = new FakeAgent();
    agent.answer = "answer-via-sdk";
    const { server } = await startApp(agent);
    server.sendEvent(messageEvent(2, "please use the sdk"));
    await waitFor(
      () =>
        server.actions.some(
          (action) =>
            action.action === "send_private_msg" &&
            actionText(action.params).includes("answer-via-sdk"),
        ),
      5000,
      "answer action",
    );
    const send = server.actions.find(
      (action) =>
        action.action === "send_private_msg" &&
        actionText(action.params).includes("answer-via-sdk"),
    );
    expect(actionText(send?.params ?? {})).toContain("answer-via-sdk");
    expect(agent.prompts[0]?.text).toBe("please use the sdk");
  });

  it("honours the access token", async () => {
    const server = new FakeNapCatServer();
    await server.start("correct-token");
    disposers.push(async () => server.stop());
    const projectPath = await mkdtemp(join(tmpdir(), "qq-sdk-token-"));
    const config = makeTestConfig({ projectPath });
    config.server.port = 0;
    config.onebot.url = server.url;
    config.onebot.access_token = "wrong-token";
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const app = new App(config, {
      logger,
      store: new SqliteStore(":memory:"),
      agent: new FakeAgent(),
    });
    disposers.push(async () => {
      await app.stop();
      logger.flush?.();
    });
    await app.start();
    const health = await app.health.snapshot();
    expect(health.onebot.connected).toBe(false);
  });
});
