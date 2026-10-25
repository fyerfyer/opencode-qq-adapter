import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/roleplay/src/memory-document.js";
import { MemoryService } from "../../packages/roleplay/src/memory-service.js";
import { parseRoleplayOptions } from "../../packages/roleplay/src/options.js";
import { TranscriptStore } from "../../packages/roleplay/src/transcript.js";
import type {
  PluginAgent,
  PluginAgentCompletion,
  PluginAgentResult,
  PluginLogger,
} from "../../src/plugins/sdk.js";
import { waitFor } from "../helpers/fakes.js";

const logger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeAgent() {
  const calls: PluginAgentCompletion[] = [];
  const agent: PluginAgent = {
    async complete(input: PluginAgentCompletion): Promise<PluginAgentResult> {
      calls.push(input);
      return {
        text: JSON.stringify({
          user_operations: [
            { op: "upsert", section: "基本信息", content: "- 称呼：鱼片", reason: "新称呼" },
            {
              op: "upsert",
              section: "喜好",
              content: "- 喜欢吃白米饭\n- 讨厌香菜",
              reason: "饮食偏好",
            },
            { op: "append", section: "最近发生", content: "- 聊了考试", reason: "近期事件" },
          ],
          scene_operations: [
            { op: "append", section: "最近发生", content: "- 群里聊了考试", reason: "群事件" },
          ],
          summary: "记录称呼、饮食和考试",
        }),
        sessionId: "ses_memory",
        usage: null,
      };
    },
  };
  return { agent, calls };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "qq-rp-service-"));
  const transcript = new TranscriptStore(join(root, "roleplay.db"));
  const documents = new MemoryDocumentStore({ root: join(root, "memory"), historyLimit: 5 });
  const fake = fakeAgent();
  const options = parseRoleplayOptions({
    memory_consolidate_every_turns: 2,
    memory_idle_debounce_ms: 0,
    memory_refresh_cooldown_ms: 0,
    ...overrides,
  });
  const service = new MemoryService({
    transcript,
    documents,
    agent: fake.agent,
    logger,
    options,
  });
  return {
    root,
    transcript,
    documents,
    service,
    calls: fake.calls,
    async close() {
      await service.dispose();
      transcript.close();
    },
  };
}

function runContext(overrides: Record<string, unknown> = {}) {
  return {
    personaId: "p",
    personaName: "角色",
    chatKey: "private:1",
    scope: "private:1",
    actorQq: 1,
    senderName: "鱼片",
    userText: "我叫鱼片，我喜欢吃白米饭。",
    replyText: "记住了。",
    sessionId: "ses_rp",
    ...overrides,
  };
}

describe("roleplay memory service", () => {
  it("stores raw messages but only consolidates at the turn threshold", async () => {
    const ctx = await setup({ memory_consolidate_every_turns: 2 });
    ctx.service.recordRun(runContext());
    await ctx.service.idle();
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.transcript.count("private:1", "p")).toBe(2);

    ctx.service.recordRun(runContext({ userText: "今天聊了考试。" }));
    await ctx.service.idle();
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]?.label).toBe("roleplay.memory.consolidate");
    expect(ctx.calls[0]?.agent).toBe("qq-rp-utility");

    const userDoc = await readFile(join(ctx.root, "memory", "p", "private_1", "memory.md"), "utf8");
    expect(userDoc).toContain("称呼：鱼片");
    expect(userDoc).toContain("喜欢吃白米饭");
    expect(userDoc).toContain("聊了考试");
    const events = ctx.service.history({ personaId: "p", scope: "private:1" });
    expect(events[0]).toMatchObject({ action: "consolidate", summary: "记录称呼、饮食和考试" });
    await ctx.close();
  });

  it("does not use a hardcoded memorable-word regex", async () => {
    const ctx = await setup({ memory_consolidate_every_turns: 8 });
    ctx.service.recordRun(runContext({ userText: "记住，我叫鱼片，我喜欢白米饭，我讨厌香菜。" }));
    await ctx.service.idle();
    expect(ctx.calls).toHaveLength(0);
    await ctx.close();
  });

  it("forces consolidation through refresh", async () => {
    const ctx = await setup({ memory_consolidate_every_turns: 99 });
    ctx.service.recordRun(runContext());
    const result = await ctx.service.refresh({
      personaId: "p",
      personaName: "角色",
      chatKey: "private:1",
      scope: "private:1",
      actorQq: 1,
      senderName: "鱼片",
    });
    expect(result).toMatchObject({ enabled: true, cooldown: false, failed: false });
    expect(result.changed).toBe(true);
    expect(ctx.calls).toHaveLength(1);
    await ctx.close();
  });

  it("consolidates after the idle debounce", async () => {
    const ctx = await setup({
      memory_consolidate_every_turns: 99,
      memory_idle_debounce_ms: 20,
    });
    ctx.service.recordRun(runContext());
    await waitFor(() => ctx.calls.length === 1, 1000, "idle consolidation");
    await ctx.service.idle();
    expect(ctx.service.lastEvent({ personaId: "p", scope: "private:1" })).not.toBeNull();
    await ctx.close();
  });

  it("does not advance the consolidation cursor when the utility agent fails", async () => {
    const ctx = await setup({ memory_consolidate_every_turns: 1 });
    const failing: PluginAgent = {
      async complete() {
        throw new Error("utility offline");
      },
    };
    const service = new MemoryService({
      transcript: ctx.transcript,
      documents: ctx.documents,
      agent: failing,
      logger,
      options: parseRoleplayOptions({ memory_consolidate_every_turns: 1 }),
    });
    service.recordRun(runContext());
    await service.idle();
    expect(ctx.transcript.lastConsolidatedMessageId("private:1", "p")).toBe(0);
    expect(service.lastEvent({ personaId: "p", scope: "private:1" })).toBeNull();
    const retry = await service.refresh({
      personaId: "p",
      personaName: "角色",
      chatKey: "private:1",
      scope: "private:1",
      actorQq: 1,
      senderName: "鱼片",
    });
    expect(retry.failed).toBe(true);
    await service.dispose();
    await ctx.close();
  });

  it("writes manual memory and removes sections", async () => {
    const ctx = await setup();
    await ctx.service.remember({
      personaId: "p",
      scope: "private:1",
      actorQq: 1,
      content: "我的生日是 3 月 14 日",
    });
    const view = await ctx.service.view({ personaId: "p", scope: "private:1", actorQq: 1 });
    expect(view.user.content).toContain("## 手动记忆");
    expect(view.user.content).toContain("3 月 14 日");
    expect(
      await ctx.service.forgetSection({
        personaId: "p",
        scope: "private:1",
        actorQq: 1,
        section: "手动记忆",
      }),
    ).toBe(false);
    const deleted = await ctx.service.forgetAll({
      personaId: "p",
      scope: "private:1",
      actorQq: 1,
    });
    expect(deleted).toEqual({ messages: 0, events: 1 });
    expect(
      (await ctx.service.view({ personaId: "p", scope: "private:1", actorQq: 1 })).user.exists,
    ).toBe(false);
    await ctx.close();
  });

  it("keeps shared scene and per-user documents separate", async () => {
    const ctx = await setup({
      memory_consolidate_every_turns: 1,
      memory_idle_debounce_ms: 0,
    });
    ctx.service.recordRun(
      runContext({
        chatKey: "group:9",
        scope: "group:9",
        userText: "群里大家好，我是鱼片。",
      }),
    );
    await ctx.service.idle();
    const userPath = join(ctx.root, "memory", "p", "group_9", "users", "1.md");
    const scenePath = join(ctx.root, "memory", "p", "group_9", "scene.md");
    expect(await readFile(userPath, "utf8")).toContain("称呼：鱼片");
    expect(await readFile(scenePath, "utf8")).toContain("群里聊了考试");

    await ctx.documents.appendManual({ personaId: "p", scope: "group:9", actorQq: 2 }, "二号群友");
    const view = await ctx.service.view({
      personaId: "p",
      scope: "group:9",
      actorQq: 1,
      allActors: true,
    });
    expect(view.shared).toBe(true);
    expect(view.allUsers).toHaveLength(2);
    expect(view.scene?.content).toContain("群里聊了考试");
    await ctx.close();
  });

  it("searches both Markdown memory and raw transcript", async () => {
    const ctx = await setup({ memory_consolidate_every_turns: 1 });
    ctx.service.recordRun(runContext());
    await ctx.service.idle();
    const result = await ctx.service.search({
      personaId: "p",
      scope: "private:1",
      actorQq: 1,
      query: "白米饭",
    });
    expect(result.docs.some((line) => line.line.includes("白米饭"))).toBe(true);
    expect(result.messages.some((message) => message.text.includes("白米饭"))).toBe(true);
    await ctx.close();
  });
});
