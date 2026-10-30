import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import {
  FakeAgent,
  FakeOneBot,
  makeIncomingMessage,
  makeTestConfig,
  waitFor,
} from "../helpers/fakes.js";

const fixture = fileURLToPath(new URL("../fixtures/plugins/profile", import.meta.url));
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function startApp() {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-session-"));
  const config = makeTestConfig({ projectPath: root });
  config.server.port = 0;
  config.storage.plugins_dir = join(root, "plugins");
  config.projects.demo = {
    ...config.projects.demo,
    path: root,
    workspace: "none",
    hidden: true,
    managed_by: "another-plugin",
  };
  config.plugins = {
    "profile-fixture": {
      enabled: true,
      path: fixture,
      options: { directory: root },
    },
    "reset-fixture": {
      enabled: true,
      path: fileURLToPath(new URL("../fixtures/plugins/reset-session", import.meta.url)),
      options: {},
    },
  };
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, { logger, store, agent: new FakeAgent(), onebot });
  await app.start();
  disposers.push(async () => {
    await app.stop();
    logger.flush?.();
  });
  return { app, onebot, config };
}

function command(name = "fx-session") {
  return {
    name,
    message: makeIncomingMessage({ text: `!${name}` }),
    args: [],
    rawArgs: "",
    actor: "owner" as const,
  };
}

describe("plugin session policy", () => {
  it("rejects hidden projects managed by another plugin and audits the plugin id", async () => {
    const { app, onebot } = await startApp();
    expect(await app.plugins.dispatchCommand(command())).toBe(true);
    await waitFor(
      () => onebot.texts().some((text) => text.includes("其他插件的内部项目")),
      2000,
      "managed_by denial",
    );
    expect(app.conversations.getConversation("private:20000")).toBeNull();

    const denied = app.store.audit
      .listRecent(20)
      .find((entry) => entry.action === "plugin.session_project_denied");
    expect(denied?.detail).toMatchObject({
      pluginId: "profile-fixture",
      projectId: "demo",
    });
  });

  it("allows the plugin to enter its own hidden project", async () => {
    const { app, config } = await startApp();
    config.projects.demo.managed_by = "profile-fixture";
    expect(await app.plugins.dispatchCommand(command())).toBe(true);
    await waitFor(
      () => app.conversations.getConversation("private:20000")?.projectId === "demo",
      2000,
      "own hidden project",
    );
    const allowed = app.store.audit
      .listRecent(20)
      .find((entry) => entry.action === "plugin.session_project");
    expect(allowed?.detail).toMatchObject({ pluginId: "profile-fixture", projectId: "demo" });
  });

  it("refuses to reset a session in another plugin's hidden project", async () => {
    const { app, config, onebot } = await startApp();
    expect(app.conversations.setProject("private:20000", "demo", 20000).ok).toBe(true);

    expect(await app.plugins.dispatchCommand(command("fx-reset"))).toBe(true);
    await waitFor(
      () => onebot.texts().some((text) => text.includes("其他插件的内部项目会话")),
      2000,
      "reset denied",
    );
    const denied = app.store.audit
      .listRecent(20)
      .find((entry) => entry.action === "plugin.session_reset_denied");
    expect(denied?.detail).toMatchObject({ pluginId: "reset-fixture" });

    config.projects.demo.managed_by = "reset-fixture";
    expect(await app.plugins.dispatchCommand(command("fx-reset"))).toBe(true);
    await waitFor(
      () => onebot.texts().some((text) => text.includes("reset-ok")),
      2000,
      "reset allowed",
    );
  });
});
