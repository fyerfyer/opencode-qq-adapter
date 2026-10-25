import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunExecutor } from "../../src/conversation/executor.js";
import type { ResolvedReplyPlan } from "../../src/conversation/reply-plan.js";
import type { ActiveRun } from "../../src/conversation/types.js";
import { buildLogger } from "../../src/observability/logger.js";
import { MessageSender } from "../../src/qq/sender.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import type { WorkspaceManager } from "../../src/workspace/manager.js";
import { FakeAgent, FakeOneBot, makeIncomingMessage, makeTestConfig } from "../helpers/fakes.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(() => {
  for (const dispose of disposers.reverse()) dispose();
  disposers.length = 0;
});

async function setup(plan: ResolvedReplyPlan, providedOneBot?: FakeOneBot) {
  const root = await mkdtemp(join(tmpdir(), "qq-reply-plan-"));
  const config = makeTestConfig({ projectPath: root });
  config.projects.demo.workspace = "none";
  const store = new SqliteStore(":memory:");
  const onebot = providedOneBot ?? new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const agent = new FakeAgent();
  agent.answer = "final answer";
  let finished: { replyText: string | null } | null = null;
  const executor = new RunExecutor(config, store, agent, sender, logger, {
    workspaces: {
      acquire: async () => {
        throw new Error("workspace lock should not be used");
      },
      release: () => undefined,
    } as unknown as WorkspaceManager,
    bindSession: () => undefined,
    unbindSession: () => undefined,
    formatReply: async () => plan,
    onFinished: (active) => {
      finished = { replyText: active.replyText };
    },
  });
  disposers.push(() => {
    store.close();
    logger.flush?.();
  });
  return { executor, onebot, agent, finished: () => finished };
}

function activeRun(): ActiveRun {
  return {
    record: {
      id: "run_reply_plan",
      chatKey: "private:20000",
      projectId: "demo",
      workspaceId: null,
      sessionId: null,
      actorQq: 20000,
      status: "queued",
      startedAt: Date.now(),
      finishedAt: null,
      stopReason: null,
      error: null,
      usageJson: null,
    },
    message: makeIncomingMessage({ text: "prompt" }),
    rawText: "prompt",
    permissions: [],
    profile: null,
    abort: new AbortController(),
    stopRequested: false,
    interrupted: false,
    agentError: null,
    partialText: "",
    usage: null,
    workspaceId: null,
    workspacePath: null,
    replyText: null,
  };
}

describe("ordered reply plan execution", () => {
  it("sends text, delayed text and image in order and records clean reply text", async () => {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
      "base64",
    );
    const plan: ResolvedReplyPlan = {
      replyText: "第一段\n第二段\n图注",
      segments: [
        { kind: "text", text: "第一段" },
        { kind: "text", text: "第二段", delayMs: 5 },
        {
          kind: "image",
          dataUri: `base64://${image.toString("base64")}`,
          caption: "图注",
          bytes: image.length,
          mime: "image/png",
          pluginId: "fixture",
          sourcePath: "/tmp/pixel.png",
          delayMs: 5,
        },
      ],
    };
    const { executor, onebot, finished } = await setup(plan);
    const active = activeRun();
    await executor.execute(active.record.chatKey, active);

    expect(onebot.sent.map((message) => message.kind)).toEqual(["reply", "private", "private"]);
    expect(onebot.sent[0]?.segments).toMatchObject([{ type: "text", text: "第一段" }]);
    expect(onebot.sent[1]?.segments).toMatchObject([{ type: "text", text: "第二段" }]);
    expect(onebot.sent[2]?.segments.map((segment) => segment.type)).toEqual(["image", "text"]);
    expect(onebot.sent[2]?.segments[1]).toMatchObject({ type: "text", text: "图注" });
    expect(finished()?.replyText).toBe("第一段\n第二段\n图注");
  });

  it("continues with later segments when an image send fails", async () => {
    class FailingImageOneBot extends FakeOneBot {
      override async sendPrivate(
        userId: number,
        segments: Parameters<FakeOneBot["sendPrivate"]>[1],
      ) {
        if (segments.some((segment) => segment.type === "image")) {
          throw new Error("image upload failed");
        }
        return super.sendPrivate(userId, segments);
      }
    }
    const { executor, onebot, finished } = await setup(
      {
        replyText: "before\nafter",
        segments: [
          { kind: "text", text: "before" },
          {
            kind: "image",
            dataUri: "base64://AA==",
            bytes: 1,
            mime: "image/png",
            pluginId: "fixture",
            sourcePath: "/tmp/missing.png",
          },
          { kind: "text", text: "after", delayMs: 5 },
        ],
      },
      new FailingImageOneBot(),
    );
    const active = activeRun();
    await executor.execute(active.record.chatKey, active);
    expect(onebot.texts()).toEqual(["before", "after"]);
    expect(finished()?.replyText).toBe("before\nafter");
  });

  it("suppresses all output for a suppress plan", async () => {
    const { executor, onebot, finished } = await setup({
      segments: [],
      suppress: true,
    });
    const active = activeRun();
    await executor.execute(active.record.chatKey, active);
    expect(onebot.sent).toEqual([]);
    expect(finished()?.replyText).toBeNull();
  });
});
