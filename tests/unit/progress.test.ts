import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../../src/conversation/manager.js";
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

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup(delayMs: number) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-progress-"));
  const config = makeTestConfig({ projectPath });
  config.qq.progress_delay_ms = delayMs;
  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const workspaces = new WorkspaceManager({ config, store, logger });
  const manager = new ConversationManager(config, store, agent, sender, logger, { workspaces });
  disposers.push(async () => {
    await manager.shutdown();
    store.close();
    logger.flush?.();
  });
  return { agent, onebot, manager };
}

describe("progress feedback", () => {
  it("sends a progress ack for a slow run and deletes it after the answer", async () => {
    const { agent, onebot, manager } = await setup(10);
    agent.autoComplete = false;
    await manager.submit(makeIncomingMessage({ text: "slow" }), "demo");
    await waitFor(
      () => onebot.texts().some((text) => text.includes("正在处理")),
      2000,
      "progress ack",
    );

    agent.complete(manager.status("private:20000").activeRun?.sessionId ?? "");
    await waitFor(
      () => onebot.texts().some((text) => text.includes("fake answer")),
      3000,
      "final answer",
    );
    await waitFor(() => onebot.deleted.length === 1, 2000, "progress deletion");
    expect(onebot.texts().some((text) => text.includes("正在处理"))).toBe(true);
  });

  it("does not send a progress ack for a fast run", async () => {
    const { onebot, manager } = await setup(5_000);
    await manager.submit(makeIncomingMessage({ text: "fast" }), "demo");
    await waitFor(
      () => onebot.texts().some((text) => text.includes("fake answer")),
      3000,
      "final answer",
    );
    expect(onebot.texts().some((text) => text.includes("正在处理"))).toBe(false);
    expect(onebot.deleted).toHaveLength(0);
  });
});
