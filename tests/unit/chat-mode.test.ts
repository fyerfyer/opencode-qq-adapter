import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_PROJECT_ID } from "../../src/chat/project.js";
import { ensureChatWorkspace } from "../../src/chat/workspace.js";
import { loadConfig } from "../../src/config/loader.js";
import { privateChat } from "../../src/domain/chat.js";
import type { IncomingMessage } from "../../src/domain/message.js";
import { PolicyEngine } from "../../src/policy/engine.js";

function message(userId: number): IncomingMessage {
  return {
    id: "1",
    chat: privateChat(userId),
    userId,
    senderName: "tester",
    text: "hello",
    images: [],
    mentionsBot: false,
    receivedAt: Date.now(),
    raw: {},
  };
}

async function configSource(root: string, chat: string): Promise<string> {
  const path = join(root, "config.yaml");
  await writeFile(
    path,
    `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
storage:
  database_path: ./data/bridge.db
  inbox_dir: ./inbox
users:
  "10001":
    role: member
    projects: []
projects: {}
${chat}
`,
    "utf8",
  );
  return path;
}

describe("project-less chat mode", () => {
  it("injects a hidden read-only @chat project for users without projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-chat-"));
    const path = await configSource(
      root,
      `chat:
  enabled: true
  allow_web: false
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    const chatPath = join(root, "data", "chat");

    expect(loaded.config.chat).toMatchObject({ enabled: true, path: chatPath });
    expect(loaded.config.projects[CHAT_PROJECT_ID]).toMatchObject({
      path: chatPath,
      workspace: "none",
      hidden: true,
    });

    const policy = new PolicyEngine(loaded.config);
    const actor = policy.actor(10001);
    if (actor === null) throw new Error("missing test actor");
    expect(policy.defaultProject(actor)?.id).toBe(CHAT_PROJECT_ID);
    expect(policy.canUseProject(actor, CHAT_PROJECT_ID).allowed).toBe(true);
    expect(policy.canWriteProject(actor, CHAT_PROJECT_ID)).toBe(false);

    const decision = policy.permissionsFor(message(10001), CHAT_PROJECT_ID);
    expect(decision).not.toBeNull();
    expect(decision?.writable).toBe(false);
    expect(decision?.effects).toMatchObject({
      read: "allow",
      edit: "deny",
      shell: "deny",
      execute: "deny",
      external_directory: "deny",
      question: "deny",
      webfetch: "deny",
      websearch: "deny",
    });
  });

  it("does not expose @chat when the mode is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-chat-off-"));
    const path = await configSource(
      root,
      `chat:
  enabled: false
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    expect(loaded.config.projects[CHAT_PROJECT_ID]).toBeUndefined();
    expect(loaded.config.chat.path).toBeNull();

    const policy = new PolicyEngine(loaded.config);
    const actor = policy.actor(10001);
    if (actor === null) throw new Error("missing test actor");
    expect(policy.defaultProject(actor)).toBeNull();
    expect(policy.permissionsFor(message(10001), CHAT_PROJECT_ID)).toBeNull();
  });

  it("creates the chat workspace and preserves an existing AGENTS.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-chat-dir-"));
    const chatPath = join(root, "chat");

    expect(ensureChatWorkspace(chatPath)).toBe(chatPath);
    const agentsPath = join(chatPath, "AGENTS.md");
    expect(await readFile(agentsPath, "utf8")).toContain("Q&A");
    expect(await readFile(agentsPath, "utf8")).toContain("question");

    await writeFile(agentsPath, "custom instructions\n", "utf8");
    ensureChatWorkspace(chatPath);
    expect(await readFile(agentsPath, "utf8")).toBe("custom instructions\n");
  });
});
