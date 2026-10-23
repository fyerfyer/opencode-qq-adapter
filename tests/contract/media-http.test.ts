import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig, waitFor } from "../helpers/fakes.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function start() {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-media-http-"));
  await writeFile(join(projectPath, "chart.png"), PNG);
  const config = makeTestConfig({ projectPath });
  config.server.port = 0;
  config.server.internal_token = "test-internal-token";
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
  return { app, projectPath, store, agent, onebot };
}

async function servePng(): Promise<string> {
  const server: Server = createServer((_request, response) => {
    response.setHeader("content-type", "image/png");
    response.setHeader("content-length", String(PNG.length));
    response.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  disposers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}/image.png`;
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

describe("Plugin media HTTP", () => {
  it("downloads an inbound QQ image and attaches it to the prompt", async () => {
    const { agent, onebot } = await start();
    const url = await servePng();
    onebot.emit({
      time: Math.floor(Date.now() / 1000),
      self_id: 10000,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 2,
      user_id: 20000,
      message: [{ type: "image", data: { url, summary: "a chart" } }],
      raw_message: "",
      sender: { user_id: 20000, nickname: "Tester" },
    });
    await waitFor(() => agent.prompts.length === 1, 3000, "image prompt");
    const prompt = agent.prompts[0];
    expect(prompt?.text).toBe("请直接查看附件图片并描述其内容，不要使用 shell 工具。");
    expect(prompt?.files).toHaveLength(1);
    expect(prompt?.files?.[0]?.uri.startsWith("file://")).toBe(true);
    expect(prompt?.files?.[0]?.description).toContain("a chart");
  });

  it("authenticates and sends a workspace image to QQ", async () => {
    const { app, store, agent, onebot } = await start();
    onebot.emit(messageEvent(1, "hello"));
    await waitFor(
      () => typeof store.conversations.get("private:20000")?.sessionId === "string",
      3000,
      "session",
    );
    const sessionId = store.conversations.get("private:20000")?.sessionId ?? "";
    void agent;

    const endpoint = `http://127.0.0.1:${app.httpPort}/internal/plugin/send-image`;
    const body = JSON.stringify({ sessionId, path: "chart.png", caption: "chart" });

    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-internal-token",
      },
      body,
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; messageId: string };
    expect(payload.ok).toBe(true);
    expect(payload.messageId).not.toBe("");

    const sent = onebot.sent.at(-1);
    expect(sent?.chat?.chatKey).toBe("private:20000");
    expect(sent?.segments[0]).toMatchObject({ type: "image" });
    expect(sent?.segments[1]).toMatchObject({ type: "text", text: "chart" });
  });

  it("authenticates and uploads a workspace file to QQ", async () => {
    const { app, projectPath, store, onebot } = await start();
    await writeFile(join(projectPath, "report.md"), "# report\n");
    onebot.emit(messageEvent(3, "make a report file"));
    await waitFor(
      () => typeof store.conversations.get("private:20000")?.sessionId === "string",
      3000,
      "session",
    );
    const sessionId = store.conversations.get("private:20000")?.sessionId ?? "";
    const response = await fetch(`http://127.0.0.1:${app.httpPort}/internal/plugin/send-file`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-internal-token",
      },
      body: JSON.stringify({ sessionId, path: "report.md", caption: "report" }),
    });
    expect(response.status).toBe(200);
    expect(onebot.uploads.at(-1)).toMatchObject({
      kind: "private",
      name: "report.md",
    });
    expect(onebot.texts()).toContain("report");
  });

  it("rejects unknown sessions", async () => {
    const { app } = await start();
    const response = await fetch(`http://127.0.0.1:${app.httpPort}/internal/plugin/send-image`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-internal-token",
      },
      body: JSON.stringify({ sessionId: "ses_unknown", path: "chart.png" }),
    });
    expect(response.status).toBe(404);
  });
});
