import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import type { ActiveRun } from "../../src/conversation/types.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import {
  FakeAgent,
  FakeOneBot,
  makeIncomingMessage,
  makeTestConfig,
  waitFor,
} from "../helpers/fakes.js";

const fixture = fileURLToPath(new URL("../fixtures/plugins/hello", import.meta.url));
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function startApp() {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-reload-gate-"));
  const config = makeTestConfig({ projectPath: root });
  config.server.port = 0;
  config.storage.plugins_dir = join(root, "plugins");
  config.plugins = {
    "hello-fixture": { enabled: true, path: fixture, options: {} },
    "slow-after-run-fixture": {
      enabled: true,
      path: fileURLToPath(new URL("../fixtures/plugins/slow-after-run", import.meta.url)),
      options: { delayMs: 400 },
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
  return { app, agent };
}

function activeRun(): ActiveRun {
  return {
    record: {
      id: "run_after_run_gate",
      chatKey: "private:20000",
      projectId: "demo",
      workspaceId: null,
      sessionId: null,
      actorQq: 20000,
      status: "completed",
      startedAt: Date.now(),
      finishedAt: Date.now(),
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
    replyText: "answer",
  };
}

describe("plugin reload maintenance gate", () => {
  it("rejects full and single-plugin reloads while a run is active", async () => {
    const { app, agent } = await startApp();
    agent.autoComplete = false;
    await app.conversations.submit(makeIncomingMessage({ text: "hold" }), "demo");
    await waitFor(() => app.conversations.activeRuns() === 1, 3000, "active run");

    await expect(app.reloadPlugins()).rejects.toThrow(/任务/);
    await expect(app.plugins.reloadPlugin("hello-fixture")).rejects.toThrow(/任务/);
    await expect(app.admin.setPluginEnabled("hello-fixture", false)).rejects.toMatchObject({
      status: 409,
      code: "plugin_busy",
    });
    expect(
      app.plugins.status().plugins.find((plugin) => plugin.id === "hello-fixture")?.status,
    ).toBe("loaded");

    await app.conversations.stop("private:20000");
    await waitFor(() => app.conversations.activeRuns() === 0, 3000, "idle");
    await waitFor(() => app.plugins.pendingTasks() === 0, 3000, "afterRun drained");
    await expect(app.reloadPlugins()).resolves.toMatchObject({ loaded: 2, failed: 0 });
    await expect(app.plugins.reloadPlugin("hello-fixture")).resolves.toBe("loaded");
  });

  it("waits for plugin afterRun work before allowing a reload", async () => {
    const { app } = await startApp();
    const pending = app.plugins.afterRun(activeRun(), "completed", null, null);
    await waitFor(() => app.plugins.pendingTasks() === 1, 1000, "in-flight afterRun");

    await expect(app.reloadPlugins()).rejects.toThrow(/插件任务/);
    await pending;
    expect(app.plugins.pendingTasks()).toBe(0);
    await expect(app.reloadPlugins()).resolves.toMatchObject({ loaded: 2, failed: 0 });
  });
});
