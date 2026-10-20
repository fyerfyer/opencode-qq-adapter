import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../../src/conversation/manager.js";
import { buildLogger } from "../../src/observability/logger.js";
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

async function setup(maxQueued = 3) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-manager-"));
  const config = makeTestConfig({ projectPath, maxQueued });
  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const manager = new ConversationManager(config, store, agent, sender, logger);
  disposers.push(async () => {
    await manager.shutdown();
    store.close();
    logger.flush?.();
  });
  return { projectPath, config, store, agent, onebot, manager };
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
});
