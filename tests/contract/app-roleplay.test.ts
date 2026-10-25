import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importCard } from "../../packages/roleplay/src/persona.js";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig, waitFor } from "../helpers/fakes.js";

const card = fileURLToPath(
  new URL("../fixtures/roleplay/blue-fat-fish.card.json", import.meta.url),
);
const packageDir = fileURLToPath(new URL("../../packages/roleplay", import.meta.url));
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

function messageEvent(id: number, text: string): Record<string, unknown> {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 10000,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: id,
    user_id: 20000,
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { user_id: 20000, nickname: "鱼片" },
  };
}

describe("Application + roleplay plugin", () => {
  it("switches to the persona project, injects context and restores the coding project", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-rp-contract-"));
    const personas = join(root, "personas");
    const personaDir = join(personas, "blue-fat-fish");
    await mkdir(personaDir, { recursive: true });
    await importCard({ sourcePath: card, personasDir: personas, id: "blue-fat-fish" });

    const config = makeTestConfig({ projectPath: root });
    config.server.port = 0;
    config.storage.plugins_dir = join(root, "plugins");
    config.projects.roleplay = {
      path: personas,
      description: "Roleplay personas",
      policy: "readonly",
      workspace: "none",
      agent: "qq-rp",
      model: null,
      allowed_users: ["20000"],
      setup: [],
      base_branch: null,
    };
    config.plugins = {
      roleplay: {
        enabled: true,
        path: packageDir,
        options: {
          project_id: "roleplay",
          agent: "qq-rp",
          install_agent: false,
          personas_dir: personas,
          memory_exclude_recent: 0,
        },
      },
    };
    const store = new SqliteStore(":memory:");
    const agent = new FakeAgent();
    const onebot = new FakeOneBot();
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const app = new App(config, { logger, store, agent, onebot });
    await app.start();
    disposers.push(async () => {
      await app.stop();
      logger.flush?.();
    });

    onebot.emit(messageEvent(1, "!use demo"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已切换到项目")),
      3000,
      "demo project",
    );

    onebot.emit(messageEvent(2, "!persona use blue-fat-fish"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("今天只吃一碗白饭")),
      3000,
      "greeting",
    );
    expect(app.conversations.getConversation("private:20000")?.projectId).toBe("roleplay");

    onebot.emit(messageEvent(3, "我想吃白饭"));
    await waitFor(() => agent.prompts.length === 1, 3000, "roleplay prompt");
    expect(agent.sessionInputs[0]).toMatchObject({
      directory: personaDir,
      agent: "qq-rp",
    });
    expect(agent.prompts[0]?.text).toContain("[检索上下文");
    expect(agent.prompts[0]?.text).toContain("[世界书]");
    await waitFor(
      () => onebot.texts().some((text) => text.includes("fake answer")),
      3000,
      "roleplay answer",
    );

    onebot.emit(messageEvent(4, "!memory search 白饭"));
    await waitFor(() => onebot.texts().some((text) => text.includes("我想吃白饭")), 3000, "memory");

    onebot.emit(messageEvent(5, "!rp off"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("角色扮演已关闭")),
      3000,
      "rp off",
    );
    expect(app.conversations.getConversation("private:20000")?.projectId).toBe("demo");
  });
});
