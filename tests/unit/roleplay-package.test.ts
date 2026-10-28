import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importCard } from "../../packages/roleplay/src/persona.js";
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

const card = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);
const packageDir = fileURLToPath(new URL("../../packages/roleplay", import.meta.url));

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

describe("roleplay package", () => {
  it("loads the built package and runs the full prompt/memory path", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-rp-package-"));
    const personasDir = join(root, "personas");
    await importCard({ sourcePath: card, personasDir, id: "blue-fat-fish" });

    const config = makeTestConfig({ projectPath: root });
    config.storage.plugins_dir = join(root, "plugins");
    const demo = config.projects.demo;
    if (demo === undefined) throw new Error("demo project missing from test config");
    config.projects.demo = {
      ...demo,
      path: personasDir,
      workspace: "none",
    };
    config.plugins = {
      roleplay: {
        enabled: true,
        path: packageDir,
        options: {
          project_id: "demo",
          personas_dir: personasDir,
          memory_exclude_recent: 0,
        },
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
      sessionActions: {
        setProject: () => ({ ok: true }),
        reset: () => ({ ok: true }),
      },
      reservedCommands: ["ping", "help"],
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

    expect(plugins.status()).toMatchObject({ loaded: 1, failed: 0 });
    const message = makeIncomingMessage({ text: "!persona use blue-fat-fish" });
    expect(
      await plugins.dispatchCommand({
        name: "persona",
        message,
        args: ["use", "blue-fat-fish"],
        rawArgs: "use blue-fat-fish",
        actor: "owner",
        groupMode: null,
      }),
    ).toBe(true);
    await waitFor(
      () => onebot.texts().some((text) => text.includes("今天只吃一碗白饭")),
      5000,
      "greeting",
    );

    await manager.submit(makeIncomingMessage({ text: "我想吃白饭" }), "demo");
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt");
    expect(agent.prompts[0]?.text).toContain("[检索上下文");
    expect(agent.prompts[0]?.text).toContain("[世界书");
    await waitFor(() => onebot.texts().some((text) => text === "fake answer"), 3000, "answer");

    const memory = await plugins.dispatchCommand({
      name: "memory",
      message: makeIncomingMessage({ text: "!memory search 白饭" }),
      args: ["search", "白饭"],
      rawArgs: "search 白饭",
      actor: "owner",
      groupMode: null,
    });
    expect(memory).toBe(true);
    await waitFor(
      () => onebot.texts().some((text) => text.includes("我想吃白饭")),
      5000,
      "memory search reply",
    );
  });
});
