import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionOwnership } from "../../src/conversation/ownership.js";
import { PluginMediaError, PluginMediaService } from "../../src/media/plugin.js";
import { AuditTrail } from "../../src/observability/audit.js";
import { buildLogger } from "../../src/observability/logger.js";
import { MessageSender } from "../../src/qq/sender.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { FakeAgent, FakeOneBot, makeTestConfig } from "../helpers/fakes.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup() {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-plugin-media-"));
  const config = makeTestConfig({ projectPath });
  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const ownership = new SessionOwnership(store, agent, logger);
  const workspaces = new WorkspaceManager({ config, store, logger });
  const audit = new AuditTrail(store, logger);
  const service = new PluginMediaService({
    config,
    store,
    ownership,
    workspaces,
    sender,
    audit,
    logger,
  });
  ownership.start();
  const workspace = workspaces.status("demo").workspace;
  store.conversations.upsert({
    chatKey: "private:20000",
    projectId: "demo",
    workspaceId: workspace?.id ?? null,
    sessionId: "ses_1",
    actorQq: 20000,
    agent: null,
    model: null,
    createdAt: 1,
    lastActiveAt: 1,
  });
  disposers.push(() => {
    ownership.stop();
    workspaces.releaseAll();
    store.close();
    logger.flush?.();
  });
  return { projectPath, store, agent, onebot, service, ownership };
}

describe("PluginMediaService", () => {
  it("sends a workspace image back to the conversation", async () => {
    const { projectPath, onebot, service } = await setup();
    await writeFile(join(projectPath, "chart.png"), PNG);
    const result = await service.sendImage({
      sessionId: "ses_1",
      path: "chart.png",
      caption: "generated chart",
    });
    expect(result.messageId).not.toBe("");
    const sent = onebot.sent.at(-1);
    expect(sent?.segments[0]).toMatchObject({ type: "image" });
    expect(sent?.segments[0]?.type === "image" ? sent.segments[0].file : "").toMatch(
      /^base64:\/\//,
    );
    expect(sent?.segments[1]).toMatchObject({ type: "text", text: "generated chart" });
  });

  it("rejects unknown sessions and paths outside the workspace", async () => {
    const { projectPath, service } = await setup();
    await expect(
      service.sendImage({ sessionId: "ses_unknown", path: "chart.png" }),
    ).rejects.toMatchObject({ status: 404 });

    const outside = await mkdtemp(join(tmpdir(), "qq-plugin-outside-"));
    await writeFile(join(outside, "secret.png"), PNG);
    await symlink(join(outside, "secret.png"), join(projectPath, "escape.png"));
    await expect(
      service.sendImage({ sessionId: "ses_1", path: "escape.png" }),
    ).rejects.toBeInstanceOf(PluginMediaError);
  });

  it("rejects non-image files", async () => {
    const { projectPath, service } = await setup();
    await writeFile(join(projectPath, "notes.txt"), "hello");
    await expect(
      service.sendImage({ sessionId: "ses_1", path: "notes.txt" }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("sends a workspace file and caption to the conversation", async () => {
    const { projectPath, onebot, service } = await setup();
    await writeFile(join(projectPath, "computer-jokes.md"), "# jokes\n");
    const result = await service.sendFile({
      sessionId: "ses_1",
      path: "computer-jokes.md",
      caption: "final report",
    });
    expect(result.messageId).toBe("");
    expect(onebot.uploads.at(-1)).toMatchObject({
      kind: "private",
      name: "computer-jokes.md",
    });
    expect(onebot.uploads.at(-1)?.file.startsWith("base64://")).toBe(true);
    expect(onebot.texts()).toContain("final report");
  });

  it("rejects sensitive files", async () => {
    const { projectPath, service } = await setup();
    await writeFile(join(projectPath, ".env"), "SECRET=1\n");
    await expect(service.sendFile({ sessionId: "ses_1", path: ".env" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("maps child sessions to their parent conversation", async () => {
    const { projectPath, agent, onebot, service } = await setup();
    await writeFile(join(projectPath, "chart.png"), PNG);
    agent.emit({
      type: "session.created",
      sessionId: "ses_child",
      data: { sessionID: "ses_child", parentID: "ses_1" },
      receivedAt: Date.now(),
    });
    await service.sendImage({ sessionId: "ses_child", path: "chart.png" });
    expect(onebot.sent).toHaveLength(1);
  });
});
