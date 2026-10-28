import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import roleplay from "../../packages/roleplay/src/index.js";
import { importCard } from "../../packages/roleplay/src/persona.js";
import { createPluginHarness, type PluginHarness } from "../../src/plugins/testing.js";

const fixture = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-rp-group-"));
  const personasDir = join(dataDir, "personas");
  await importCard({ sourcePath: fixture, personasDir, id: "blue-fat-fish" });
  const harness: PluginHarness<unknown> = await createPluginHarness(roleplay, {
    dataDir,
    options: {
      project_id: "roleplay",
      personas_dir: personasDir,
      memory_exclude_recent: 0,
      memory_consolidate_every_turns: 99,
      memory_idle_debounce_ms: 0,
    },
  });
  disposers.push(async () => harness.dispose());
  return { harness, dataDir };
}

function groupMessage(userId: number, chatKey: string, senderName = `群友${userId}`) {
  return {
    id: `m-${userId}-${chatKey}`,
    chat: { type: "group" as const, userId, groupId: 922216566, chatKey },
    userId,
    senderName,
    text: "群聊消息",
    images: [],
    mentionsBot: true,
    receivedAt: Date.now(),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("roleplay group support", () => {
  it("isolates per_user group chats and writes a Markdown doc per member", async () => {
    const { harness, dataDir } = await setup();
    const chatKey = "group:922216566:10001";
    const greeting = await harness.runCommand("persona", {
      args: ["use", "blue-fat-fish"],
      message: groupMessage(10001, chatKey),
      groupMode: "per_user",
      actorRole: "member",
    });
    expect(greeting).toContain("今天只吃一碗白饭");

    const remembered = await harness.runCommand("remember", {
      args: ["我喜欢白米饭"],
      rawArgs: "我喜欢白米饭",
      message: groupMessage(10001, chatKey),
      groupMode: "per_user",
      actorRole: "member",
    });
    expect(remembered).toContain("已写入手动记忆");
    const path = join(dataDir, "memory", "blue-fat-fish", "group_922216566_10001", "memory.md");
    expect(await readFile(path, "utf8")).toContain("我喜欢白米饭");

    const memory = await harness.runCommand("memory", {
      message: groupMessage(10001, chatKey),
      groupMode: "per_user",
      actorRole: "member",
    });
    expect(memory).toBe("已私聊你。");
    const dm = harness.sent.filter((entry) => entry.chat.type === "private").at(-1);
    expect(dm?.text).toContain("我喜欢白米饭");

    const deleted = await harness.runCommand("forget", {
      args: ["confirm"],
      message: groupMessage(10001, chatKey),
      groupMode: "per_user",
      actorRole: "member",
    });
    expect(deleted).toContain("已删除记忆");
    expect(await exists(path)).toBe(false);
  });

  it("keeps shared scene and per-user docs, and restricts management to owner/admin", async () => {
    const { harness, dataDir } = await setup();
    const sharedKey = "group:922216566";
    const greeting = await harness.runCommand("persona", {
      args: ["use", "blue-fat-fish"],
      message: groupMessage(10009, sharedKey),
      groupMode: "shared",
      actorRole: "admin",
    });
    expect(greeting).toContain("今天只吃一碗白饭");

    const remembered = await harness.runCommand("remember", {
      args: ["我是二号群友"],
      rawArgs: "我是二号群友",
      message: groupMessage(10002, sharedKey),
      groupMode: "shared",
      actorRole: "member",
    });
    expect(remembered).toContain("已写入手动记忆");
    const userPath = join(
      dataDir,
      "memory",
      "blue-fat-fish",
      "group_922216566",
      "users",
      "10002.md",
    );
    expect(await readFile(userPath, "utf8")).toContain("我是二号群友");

    const memberMemory = await harness.runCommand("memory", {
      message: groupMessage(10002, sharedKey),
      groupMode: "shared",
      actorRole: "member",
    });
    expect(memberMemory).toContain("只有 owner/admin");

    const adminMemory = await harness.runCommand("memory", {
      message: groupMessage(10009, sharedKey),
      groupMode: "shared",
      actorRole: "admin",
    });
    expect(adminMemory).toBe("已私聊你。");
    const dm = harness.sent.filter((entry) => entry.chat.type === "private").at(-1);
    expect(dm?.text).toContain("群成员记忆");
    expect(dm?.text).toContain("我是二号群友");

    const memberDelete = await harness.runCommand("forget", {
      args: ["confirm"],
      message: groupMessage(10002, sharedKey),
      groupMode: "shared",
      actorRole: "member",
    });
    expect(memberDelete).toContain("只有 owner/admin");
    const adminDelete = await harness.runCommand("forget", {
      args: ["confirm"],
      message: groupMessage(10009, sharedKey),
      groupMode: "shared",
      actorRole: "admin",
    });
    expect(adminDelete).toContain("已删除记忆");
    expect(await exists(userPath)).toBe(false);
  });

  it("allows each per_user member to choose their own persona", async () => {
    const { harness } = await setup();
    const firstKey = "group:922216566:10001";
    const secondKey = "group:922216566:10002";
    await harness.runCommand("persona", {
      args: ["use", "blue-fat-fish"],
      message: groupMessage(10001, firstKey),
      groupMode: "per_user",
      actorRole: "member",
    });
    await harness.runCommand("persona", {
      args: ["use", "blue-fat-fish"],
      message: groupMessage(10002, secondKey),
      groupMode: "per_user",
      actorRole: "member",
    });
    expect(harness.sessionCalls).toContainEqual({
      action: "setProject",
      chatKey: firstKey,
      projectId: "roleplay",
      actorQq: 10001,
    });
    expect(harness.sessionCalls).toContainEqual({
      action: "setProject",
      chatKey: secondKey,
      projectId: "roleplay",
      actorQq: 10002,
    });
  });
});
