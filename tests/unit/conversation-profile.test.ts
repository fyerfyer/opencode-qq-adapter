import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationManager } from "../../src/conversation/manager.js";
import { buildLogger } from "../../src/observability/logger.js";
import { PluginHost } from "../../src/plugins/host.js";
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

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}`, import.meta.url));

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-rp-manager-"));
  const personas = join(root, "personas");
  const persona = join(personas, "blue-fat-fish");
  await mkdir(persona, { recursive: true });
  const config = makeTestConfig({ projectPath: root });
  config.storage.plugins_dir = join(root, "plugins");
  const demo = config.projects.demo;
  if (demo === undefined) throw new Error("demo project missing from test config");
  config.projects.demo = {
    ...demo,
    path: personas,
    workspace: "none",
    agent: "build",
    model: "fake/model-b",
  };
  config.plugins = {
    "profile-fixture": {
      enabled: true,
      path: fixture("profile"),
      options: { directory: persona },
    },
  };

  const store = new SqliteStore(":memory:");
  const agent = new FakeAgent();
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const workspaces = new WorkspaceManager({ config, store, logger });
  const plugins = new PluginHost({
    config,
    logger,
    audit: { record: () => undefined } as never,
    sender,
    conversations: { getConversation: (chatKey) => store.conversations.get(chatKey) },
    reservedCommands: [],
    coreVersion: "0.1.1",
  });
  await plugins.start();
  const manager = new ConversationManager(config, store, agent, sender, logger, {
    workspaces,
    plugins,
  });
  disposers.push(async () => {
    await manager.shutdown();
    await plugins.stop();
    store.close();
    logger.flush?.();
  });
  return { root, persona, config, store, agent, onebot, manager, workspaces };
}

describe("ConversationManager roleplay profile", () => {
  it("runs in the profile directory without a workspace lock and uses project agent/model", async () => {
    const { persona, store, agent, manager, workspaces } = await setup();
    const message = makeIncomingMessage({ text: "raw hello" });
    const result = await manager.submit(message, "demo");
    expect(result.accepted).toBe(true);
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");

    expect(agent.sessionInputs[0]).toMatchObject({
      directory: persona,
      agent: "build",
      model: "fake/model-b",
    });
    expect(store.conversations.get("private:20000")?.workspaceId).toBeNull();
    expect(store.runs.listRecent("private:20000", 1)[0]?.workspaceId).toBeNull();
    expect(workspaces.status("demo").workspace).toBeNull();
  });

  it("sends plugin-planned reply segments and records raw user/assistant text", async () => {
    const { root, agent, onebot, manager } = await setup();
    await manager.submit(makeIncomingMessage({ text: "raw question" }), "demo");
    await waitFor(() => onebot.texts().length >= 2, 3000, "segmented reply");
    expect(onebot.texts()).toEqual(["fak", "e answer"]);

    const run = JSON.parse(
      await readFile(join(root, "plugins", "profile-fixture", "last-run.json"), "utf8"),
    ) as { userText: string; replyText: string };
    expect(run).toEqual({ userText: "raw question", replyText: "fake answer" });
    expect(agent.prompts[0]?.text).toBe("raw question");
  });
});
