import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import roleplay from "../../packages/roleplay/src/index.js";
import { getPersona, importCard } from "../../packages/roleplay/src/persona.js";
import type { PluginRunContext } from "../../src/plugins/sdk.js";
import { createPluginHarness, type PluginHarness } from "../../src/plugins/testing.js";

const fixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup(extraOptions: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-rp-plugin-"));
  const personasDir = join(dataDir, "personas");
  await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
  const harness: PluginHarness<unknown> = await createPluginHarness(roleplay, {
    dataDir,
    options: {
      project_id: "roleplay",
      agent: "qq-rp",
      install_agent: false,
      personas_dir: personasDir,
      memory_exclude_recent: 0,
      ...extraOptions,
    },
  });
  disposers.push(async () => harness.dispose());
  return { harness, dataDir, personasDir };
}

function message(text: string) {
  return {
    id: "m1",
    chat: { type: "private" as const, userId: 10001, chatKey: "private:10001" },
    userId: 10001,
    senderName: "鱼片",
    text,
    images: [],
    mentionsBot: false,
    receivedAt: Date.now(),
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
    promptText: "我想吃白饭",
    userText: "我想吃白饭",
    replyText: "哼，给你一碗。",
    ...overrides,
  };
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

  it("resolves the persona directory and injects worldbook plus greeting context", async () => {
    const { harness, personasDir } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const profile = await harness.resolveProfile({
      message: message("我想吃白饭"),
      projectId: "roleplay",
      conversation: null,
    });
    expect(profile).toMatchObject({
      directory: join(personasDir, "blue-fat-fish"),
      agent: "qq-rp",
      workspace: "none",
    });

    const prompt = await harness.beforePrompt({
      message: message("我想吃白饭"),
      projectId: "roleplay",
      conversation: null,
      profile,
    });
    expect(prompt?.prepend).toContain("[检索上下文");
    expect(prompt?.prepend).toContain("[世界书]");
    expect(prompt?.prepend).toContain("白米饭");
    expect(prompt?.prepend).toContain("你刚才对鱼片说");
  });

  it("plans segmented replies and records raw transcript memory", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    const plan = await harness.formatReply({
      message: message("随便聊聊"),
      projectId: "roleplay",
      conversation: null,
      profile: null,
      text: "第一句。第二句！",
    });
    expect(plan?.segments).toHaveLength(2);
    expect(plan?.segments[1]?.delayMs).toBeGreaterThan(0);

    await harness.afterRun(runContext());
    const memory = await harness.runCommand("memory");
    expect(memory).toContain("我想吃白饭");
    expect(memory).toContain("哼，给你一碗。");
  });

  it("forgets transcript memory after confirmation", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await harness.afterRun(runContext());
    const refused = await harness.runCommand("forget");
    expect(refused).toContain("确认");
    const deleted = await harness.runCommand("forget", { args: ["confirm"] });
    expect(deleted).toContain("已删除");
    const memory = await harness.runCommand("memory");
    expect(memory).toContain("还没有记忆");
  });

  it("disables roleplay and restores the previous project", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    harness.sessionCalls.length = 0;
    const result = await harness.runCommand("rp", { args: ["off"] });
    expect(result).toContain("已关闭");
    expect(harness.sessionCalls[0]).toMatchObject({ action: "reset" });
  });

  it("can still forget memory after roleplay is disabled", async () => {
    const { harness } = await setup();
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    await harness.afterRun(runContext());
    await harness.runCommand("rp", { args: ["off"] });
    const deleted = await harness.runCommand("forget", { args: ["confirm"] });
    expect(deleted).toContain("已删除");
  });

  it("restores a configured fallback project when there is no previous project", async () => {
    const { harness } = await setup({ fallback_project: "demo" });
    await harness.runCommand("persona", { args: ["use", "blue-fat-fish"] });
    harness.sessionCalls.length = 0;
    const result = await harness.runCommand("rp", { args: ["off"] });
    expect(result).toContain("已关闭");
    expect(harness.sessionCalls).toContainEqual({
      action: "setProject",
      chatKey: "private:10001",
      projectId: "demo",
      actorQq: 10001,
    });
  });
});
