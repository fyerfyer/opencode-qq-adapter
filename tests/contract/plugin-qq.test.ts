import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig, waitFor } from "../helpers/fakes.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}`, import.meta.url));

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function startApp() {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-plugin-contract-"));
  const config = makeTestConfig({ projectPath });
  config.server.port = 0;
  config.storage.plugins_dir = join(projectPath, "plugins");
  config.plugins = {
    "hello-fixture": {
      enabled: true,
      path: fixture("hello"),
      options: { greeting: "contract-hello" },
    },
    "broken-fixture": {
      enabled: true,
      path: fixture("broken"),
      options: {},
    },
  };
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const agent = new FakeAgent();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, { logger, store, agent, onebot });
  await app.start();
  disposers.push(async () => {
    await app.stop();
    logger.flush?.();
  });
  return { app, config, onebot, agent, projectPath };
}

function messageEvent(id: number, text: string, userId = 20000): Record<string, unknown> {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 10000,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: id,
    user_id: userId,
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { user_id: userId, nickname: "Tester" },
  };
}

describe("Plugin SDK + QQ routing contract", () => {
  it("routes plugin commands and lists plugin status without core changes", async () => {
    const { onebot } = await startApp();

    onebot.emit(messageEvent(1, "!plugins"));
    await waitFor(
      () =>
        onebot
          .texts()
          .some((text) => text.includes("hello-fixture") && text.includes("broken-fixture")),
      3000,
      "plugin list",
    );

    onebot.emit(messageEvent(2, "!fx-hello"));
    await waitFor(() => onebot.texts().includes("contract-hello"), 3000, "plugin command reply");

    onebot.emit(messageEvent(3, "!fx-repeat alias-ok", 20000));
    await waitFor(() => onebot.texts().includes("alias-ok"), 3000, "plugin command alias");

    onebot.emit(messageEvent(4, "!help"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("fx-hello")),
      3000,
      "help includes plugin commands",
    );

    onebot.emit(messageEvent(5, "!ping"));
    await waitFor(
      () => onebot.texts().includes("pong"),
      3000,
      "core command still works with a broken plugin",
    );
  });

  it("injects prompt context, sends media and records afterRun", async () => {
    const { app, onebot, agent, projectPath } = await startApp();

    onebot.emit(messageEvent(10, "please inspect the repo"));
    await waitFor(() => agent.prompts.length === 1, 3000, "prompt delivery");
    expect(agent.prompts[0]?.text).toBe("please inspect the repo\n\n[fixture-context:demo]");

    onebot.emit(messageEvent(11, "!fx-image"));
    await waitFor(
      () =>
        onebot.sent.some((message) => message.segments.some((segment) => segment.type === "image")),
      3000,
      "image segment",
    );
    expect(onebot.texts().some((text) => text.startsWith("image:"))).toBe(true);

    onebot.emit(messageEvent(12, "!fx-session"));
    await waitFor(
      () => onebot.texts().some((text) => text.trim() === "demo"),
      3000,
      "session snapshot",
    );

    const lastRunPath = join(projectPath, "plugins", "hello-fixture", "last-run.json");
    await waitForFile(lastRunPath);
    const lastRun = JSON.parse(await readFile(lastRunPath, "utf8")) as {
      status: string;
      error: string | null;
    };
    expect(lastRun.status).toBe("completed");
    expect(lastRun.error).toBeNull();

    const eventPath = join(projectPath, "plugins", "hello-fixture", "event.json");
    await waitForFile(eventPath);
    const event = JSON.parse(await readFile(eventPath, "utf8")) as { type: string };
    expect(event.type).toBe("run.finished");

    const status = app.plugins.status();
    expect(status.loaded).toBe(1);
    expect(status.failed).toBe(1);
  });
});

async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
