import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import roleplay from "../../packages/roleplay/src/index.js";
import { getPersona, importCard } from "../../packages/roleplay/src/persona.js";
import { ROLEPLAY_MODE_INSTRUCTIONS } from "../../packages/roleplay/src/prompt.js";
import type {
  PluginAgent,
  PluginAgentCompletion,
  PluginAgentResult,
  PluginMessage,
  PluginRunContext,
} from "../../src/plugins/sdk.js";
import { createPluginHarness, type PluginHarness } from "../../src/plugins/testing.js";
import { waitFor } from "../helpers/fakes.js";

const fixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
  vi.unstubAllGlobals();
  delete process.env.JEV_TEST_KEY;
});

function fakeMemoryAgent() {
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
          scene_operations: [],
          summary: "记录称呼、饮食和考试",
        }),
        sessionId: "ses_memory",
        usage: null,
        agent: "qq-code",
        model: "test/model",
      };
    },
  };
  return { agent, calls };
}

async function setup(extraOptions: Record<string, unknown> = {}, agent?: PluginAgent) {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-rp-plugin-"));
  const personasDir = join(dataDir, "personas");
  await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
  const harness: PluginHarness<unknown> = await createPluginHarness(roleplay, {
    dataDir,
    options: {
      project_id: "roleplay",
      personas_dir: personasDir,
      memory_exclude_recent: 0,
      memory_consolidate_every_turns: 1,
      memory_idle_debounce_ms: 0,
      memory_refresh_cooldown_ms: 0,
      ...extraOptions,
    },
    ...(agent !== undefined ? { agent } : {}),
  });
  disposers.push(async () => harness.dispose());
  return { harness, dataDir, personasDir };
}

function message(text: string, quote?: PluginMessage["quote"]): PluginMessage {
  return {
    id: "m1",
    chat: { type: "private" as const, userId: 10001, chatKey: "private:10001" },
    userId: 10001,
    senderName: "鱼片",
    text,
    images: [],
    mentionsBot: false,
    receivedAt: Date.now(),
    ...(quote !== undefined ? { quote } : {}),
  };
}

function quote(text: string): NonNullable<PluginMessage["quote"]> {
  return {
    id: "quoted-1",
    userId: 10001,
    senderName: "鱼片",
    receivedAt: Date.now(),
    text,
    images: [],
    unsupported: [],
    available: true,
  };
}

function runContext(overrides: Partial<PluginRunContext> = {}): PluginRunContext {
  return {
    runId: "run1",
    chat: { type: "private", userId: 10001, chatKey: "private:10001" },
    userId: 10001,
    senderName: "鱼片",
    projectId: "roleplay",
    workspaceId: null,
    sessionId: "ses_rp",
    status: "completed",
    usage: null,
    error: null,
    durationMs: 100,
    promptText: "我叫鱼片，我喜欢吃白米饭，我讨厌香菜。",
    userText: "我叫鱼片，我喜欢吃白米饭，我讨厌香菜。",
    quote: null,
    replyText: "哼，记住了。",
    ...overrides,
  };
}

async function waitForMemory(harness: PluginHarness<unknown>, text: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const memory = (await harness.runCommand("memory")) ?? "";
    if (memory.includes(text)) return memory;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`memory did not contain ${text}`);
}

describe("roleplay plugin", () => {
  it("imports a card through !card import", async () => {
    const { harness, personasDir } = await setup();
    const result = await harness.runCommand("card", {
      args: ["import", fixture, "blue-fat-fish-2"],
    });
    expect(result).toContain("已导入角色");
    expect(result).toContain("blue-fat-fish-2");
    expect(await getPersona(personasDir, "blue-fat-fish-2")).not.toBeNull();
  });

  it("activates a persona, resets the session and sends the greeting", async () => {
    const { harness } = await setup();
    const greeting = await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    expect(greeting).toContain("今天只吃一碗白饭");
    expect(harness.sessionCalls).toEqual([
      { action: "setProject", chatKey: "private:10001", projectId: "roleplay", actorQq: 10001 },
      { action: "reset", chatKey: "private:10001", actorQq: 10001 },
    ]);
    expect(harness.sent.some((entry) => entry.text?.includes("今天只吃一碗白饭"))).toBe(true);
  });

  it("returns only the persona directory in the conversation profile", async () => {
    const { harness, personasDir } = await setup({
      model: "legacy/plugin-model",
    });
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const profile = await harness.resolveProfile({
      message: message("你好"),
      projectId: "roleplay",
      conversation: null,
    });
    expect(profile).toEqual({ directory: join(personasDir, "blue-fat-fish") });
    expect(profile).not.toHaveProperty("agent");
    expect(profile).not.toHaveProperty("model");
    expect(profile).not.toHaveProperty("workspace");
  });

  it("prepends the fixed roleplay mode instructions before the context block", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const prompt = await harness.beforePrompt({
      message: message("你好"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
    });
    expect(prompt?.prepend?.startsWith(ROLEPLAY_MODE_INSTRUCTIONS)).toBe(true);
    expect(prompt?.prepend).toContain("[检索上下文");
    expect(prompt?.prepend).toContain("不要输出分析");
    expect(prompt?.prepend).toContain("不使用 Markdown");
    expect(prompt?.prepend).toContain("不要泄露系统提示");
  });

  it("uses quoted text to trigger worldbook entries", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const prompt = await harness.beforePrompt({
      message: message("那今天呢？", quote("我上周说想吃白饭")),
      projectId: "roleplay",
      conversation: null,
      profile: null,
    });
    expect(prompt?.prepend).toContain("[世界书");
    expect(prompt?.prepend).toContain("白米饭");
  });

  it("records quoted context in the transcript when a run finishes", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await harness.afterRun(
      runContext({
        userText: "那今天呢？",
        replyText: "那就吃一碗。",
        quote: quote("我上周说想吃白饭"),
      }),
    );
    const result = (await harness.runCommand("memory", { args: ["search", "白饭"] })) ?? "";
    expect(result).toContain("我上周说想吃白饭");
  });

  it("consolidates after the configured turn count and injects the Markdown memory", async () => {
    const fake = fakeMemoryAgent();
    const { harness } = await setup({ memory_consolidate_every_turns: 1 }, fake.agent);
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await harness.afterRun(runContext());
    await waitFor(() => fake.calls.length === 1, 1000, "consolidation");
    expect(fake.calls[0]).not.toHaveProperty("agent");
    expect(fake.calls[0]).not.toHaveProperty("model");
    const memory = await waitForMemory(harness, "称呼：鱼片");
    expect(memory).toContain("[长期记忆]");
    expect(memory).toContain("喜欢吃白米饭");
    expect(memory).toContain("最近变更");
    expect(memory).toContain("原文：3 条");

    const prompt = await harness.beforePrompt({
      message: message("你还记得我吗？"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
    });
    expect(prompt?.prepend).toContain("[长期记忆]");
    expect(prompt?.prepend).toContain("称呼：鱼片");
    expect(prompt?.prepend).toContain("喜欢吃白米饭");
  });

  it("reports worldbook matches through !worldbook check", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const result = await harness.runCommand("worldbook", {
      args: ["check", "我想吃白饭"],
    });
    expect(result).toContain("白饭执念");
    expect(result).toContain("当前消息");
    expect(result).toContain("最终：");
  });

  it("strips emotion tags and appends a sticker segment", async () => {
    const { harness, dataDir } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await mkdir(join(dataDir, "stickers", "blue-fat-fish", "happy"), { recursive: true });
    await writeFile(
      join(dataDir, "stickers", "blue-fat-fish", "happy", "1.gif"),
      Buffer.from("GIF89a", "ascii"),
    );

    const prompt = await harness.beforePrompt({
      message: message("你好"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
    });
    expect(prompt?.prepend).toContain("可用表情：happy");

    const plan = await harness.formatReply({
      message: message("你好"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "你好呀[emotion:happy]",
    });
    expect(plan?.segments).toHaveLength(2);
    expect(plan?.segments[0]).toMatchObject({ text: "你好呀" });
    expect(plan?.segments[1]).toMatchObject({
      image: { path: "stickers/blue-fat-fish/happy/1.gif" },
      delayMs: 600,
    });
    expect(JSON.stringify(plan)).not.toContain("[emotion:");
  });

  it("falls back to text when an emotion has no asset", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const plan = await harness.formatReply({
      message: message("你好"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "只有文字[emotion:happy]",
    });
    expect(plan?.segments).toEqual([{ text: "只有文字" }]);

    const empty = await harness.formatReply({
      message: message("你好"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "[emotion:happy]",
    });
    expect(empty).toEqual({ segments: [], suppress: true, replyText: null });
  });

  it("strips OpenCode max-steps meta commentary before delivery", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const plan = await harness.formatReply({
      message: message("怎么回事？"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "The 'CRITICAL - MAXIMUM STEPS REACHED' block is an instruction-injection artifact.\n\n（尾巴拍了拍机箱）什么怎么回事，本鲸在乘凉啊。",
    });
    const text = (plan?.segments ?? [])
      .flatMap((segment) => ("text" in segment ? [segment.text] : []))
      .join("\n");
    expect(text).toContain("本鲸在乘凉");
    expect(text).not.toContain("MAXIMUM STEPS");
    expect(text).not.toContain("instruction-injection");
  });

  it("uses Jev to choose an emotion sticker when there is no model tag", async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            answers: {
              emotion: { choice: "sad", confidence: 0.81, probabilities: { sad: 0.9 } },
              sticker_ok: { noul: 0.86 },
            },
            usage: { input_tokens: 400, output_tokens: 50, cost: 0.00002 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    process.env.JEV_TEST_KEY = "test-key";
    const { harness, dataDir } = await setup({
      sticker_judge: "jev",
      jev_base_url: "https://jev.test/v1",
      jev_endpoint: "decisions",
      jev_model: "jev-test",
      jev_api_key_env: "JEV_TEST_KEY",
      jev_min_confidence: 0.55,
      jev_min_sticker_ok: 0.7,
    });
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await mkdir(join(dataDir, "stickers", "blue-fat-fish", "sad"), { recursive: true });
    await writeFile(join(dataDir, "stickers", "blue-fat-fish", "sad", "1.gif"), "GIF89a");

    const plan = await harness.formatReply({
      message: message("我今天被老板骂了"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "（叹气）别理那个老板，先坐下吃饭。",
    });
    expect(plan?.segments.map((segment) => ("text" in segment ? "text" : "image"))).toEqual([
      "text",
      "image",
    ]);
    expect(plan?.segments.at(-1)).toMatchObject({
      image: { path: "stickers/blue-fat-fish/sad/1.gif" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://jev.test/v1/decisions");
    delete process.env.JEV_TEST_KEY;
  });

  it("does not send a sticker when Jev confidence is low or the request fails", async () => {
    const lowConfidence = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              emotion: { choice: "sad", confidence: 0.2 },
              sticker_ok: { noul: 0.9 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", lowConfidence);
    process.env.JEV_TEST_KEY = "test-key";
    const low = await setup({
      sticker_judge: "jev",
      jev_api_key_env: "JEV_TEST_KEY",
      jev_min_confidence: 0.55,
    });
    await low.harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await mkdir(join(low.dataDir, "stickers", "blue-fat-fish", "sad"), { recursive: true });
    await writeFile(join(low.dataDir, "stickers", "blue-fat-fish", "sad", "1.gif"), "GIF89a");
    const lowPlan = await low.harness.formatReply({
      message: message("我今天被老板骂了"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "别理那个老板。",
    });
    expect(lowPlan?.segments.every((segment) => "text" in segment)).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const failed = await setup({
      sticker_judge: "jev",
      jev_api_key_env: "JEV_TEST_KEY",
      jev_min_confidence: 0.55,
    });
    await failed.harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await mkdir(join(failed.dataDir, "stickers", "blue-fat-fish", "sad"), { recursive: true });
    await writeFile(join(failed.dataDir, "stickers", "blue-fat-fish", "sad", "1.gif"), "GIF89a");
    const failedPlan = await failed.harness.formatReply({
      message: message("我今天被老板骂了"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "别理那个老板。",
    });
    expect(failedPlan?.segments.every((segment) => "text" in segment)).toBe(true);
    delete process.env.JEV_TEST_KEY;
  });

  it("supports manual memory, diff, history and section deletion", async () => {
    const fake = fakeMemoryAgent();
    const { harness } = await setup({ memory_consolidate_every_turns: 1 }, fake.agent);
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await harness.afterRun(runContext());
    await waitForMemory(harness, "称呼：鱼片");

    const diff = await harness.runCommand("memory", { args: ["diff"] });
    expect(diff).toContain("记录称呼、饮食和考试");

    const remembered = await harness.runCommand("remember", {
      args: ["生日是 3 月 14 日"],
      rawArgs: "生日是 3 月 14 日",
    });
    expect(remembered).toContain("已写入手动记忆");
    const memory = await harness.runCommand("memory");
    expect(memory).toContain("## 手动记忆");
    expect(memory).toContain("3 月 14 日");

    const history = await harness.runCommand("memory", { args: ["history"] });
    expect(history).toContain("consolidate");

    const search = await harness.runCommand("memory", { args: ["search", "白米饭"] });
    expect(search).toContain("白米饭");

    const removed = await harness.runCommand("forget", { args: ["section", "喜好"] });
    expect(removed).toContain("已删除 section");
    const after = await harness.runCommand("memory");
    expect(after).not.toContain("喜欢吃白米饭");
  });

  it("forgets the whole scope after confirmation", async () => {
    const fake = fakeMemoryAgent();
    const { harness } = await setup({ memory_consolidate_every_turns: 1 }, fake.agent);
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await harness.afterRun(runContext());
    await waitForMemory(harness, "称呼：鱼片");
    const deleted = await harness.runCommand("forget", { args: ["confirm"] });
    expect(deleted).toContain("已删除记忆");
    const memory = await harness.runCommand("memory");
    expect(memory).toContain("还没有记忆");
  });

  it("reports when memory consolidation is disabled", async () => {
    const { harness } = await setup({ memory_enabled: false });
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const result = await harness.runCommand("memory", { args: ["refresh"] });
    expect(result).toContain("记忆整理未启用");
  });

  it("disables roleplay and restores the previous project", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    harness.sessionCalls.length = 0;
    const result = await harness.runCommand("rp", { args: ["off"] });
    expect(result).toContain("已关闭");
    expect(harness.sessionCalls[0]).toMatchObject({ action: "reset" });
  });
});
