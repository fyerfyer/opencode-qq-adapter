import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveRun } from "../../src/conversation/types.js";
import type { RunRecord } from "../../src/domain/conversation.js";
import { AuditTrail } from "../../src/observability/audit.js";
import { buildLogger } from "../../src/observability/logger.js";
import { PluginHost } from "../../src/plugins/host.js";
import { MessageSender } from "../../src/qq/sender.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeOneBot, makeIncomingMessage, makeTestConfig, waitFor } from "../helpers/fakes.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}`, import.meta.url));

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function makeHost(
  plugins: Record<string, { enabled?: boolean; path: string; options?: Record<string, unknown> }>,
) {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-host-"));
  const config = makeTestConfig({ projectPath: root });
  config.storage.plugins_dir = join(root, "plugins");
  config.plugins = Object.fromEntries(
    Object.entries(plugins).map(([id, plugin]) => [
      id,
      {
        enabled: plugin.enabled ?? true,
        path: plugin.path,
        options: plugin.options ?? {},
      },
    ]),
  );
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const audit = new AuditTrail(store, logger);
  const host = new PluginHost({
    config,
    logger,
    audit,
    sender,
    conversations: { getConversation: () => null },
    reservedCommands: ["ping", "help", "fx-reserved"],
    coreVersion: "0.1.1",
  });
  await host.start();
  disposers.push(async () => {
    await host.stop();
    store.close();
    logger.flush?.();
  });
  return { host, onebot, config, root };
}

function command(
  name: string,
  options: { args?: string[]; actor?: "owner" | "admin" | "member"; group?: boolean } = {},
) {
  const message = makeIncomingMessage({
    text: `!${name}`,
    ...(options.group
      ? {
          chat: {
            type: "group" as const,
            userId: 20000,
            groupId: 30001,
            chatKey: "group:30001:20000",
          },
        }
      : {}),
  });
  return {
    name,
    message,
    args: options.args ?? [],
    rawArgs: (options.args ?? []).join(" "),
    actor: options.actor ?? ("owner" as const),
    groupMode: options.group ? ("shared" as const) : null,
  };
}

describe("PluginHost", () => {
  it("loads a valid plugin, registers commands and executes aliases", async () => {
    const { host, onebot } = await makeHost({ "hello-fixture": { path: fixture("hello") } });
    const status = host.status();
    expect(status.loaded).toBe(1);
    expect(status.plugins[0]).toMatchObject({
      id: "hello-fixture",
      status: "loaded",
      version: "0.1.0",
    });

    expect(await host.dispatchCommand(command("fx-hello"))).toBe(true);
    await waitFor(() => onebot.texts().includes("fixture-hello"), 1000, "fx-hello reply");

    expect(await host.dispatchCommand(command("fx-repeat", { args: ["a", "b"] }))).toBe(true);
    await waitFor(() => onebot.texts().includes("a b"), 1000, "alias reply");
  });

  it("isolates setup, options and manifest failures", async () => {
    const { host, onebot } = await makeHost({
      "hello-fixture": { path: fixture("hello") },
      "broken-fixture": { path: fixture("broken") },
      "incompatible-fixture": { path: fixture("incompatible") },
      "bad-options-fixture": { path: fixture("bad-options") },
      "conflict-fixture": { path: fixture("conflict") },
    });
    const status = host.status();
    expect(status.loaded).toBe(1);
    expect(status.failed).toBe(4);
    const byId = new Map(status.plugins.map((plugin) => [plugin.id, plugin]));
    expect(byId.get("broken-fixture")?.error).toContain("intentional fixture failure");
    expect(byId.get("incompatible-fixture")?.error).toContain("requires opencode-qq >=9.0.0");
    expect(byId.get("bad-options-fixture")?.error).toContain("token is required");
    expect(byId.get("conflict-fixture")?.error).toContain("reserved");

    expect(await host.dispatchCommand(command("fx-hello"))).toBe(true);
    await waitFor(() => onebot.texts().includes("fixture-hello"), 1000, "valid plugin still works");
  });

  it("enforces roles, chat types and shared-group opt-in", async () => {
    const { host, onebot } = await makeHost({ "hello-fixture": { path: fixture("hello") } });

    await host.dispatchCommand(command("fx-owner", { actor: "member" }));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("需要 owner")),
      1000,
      "role denial",
    );

    await host.dispatchCommand(command("fx-private", { group: true }));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("不支持当前会话类型")),
      1000,
      "chat denial",
    );

    await host.dispatchCommand(command("fx-shared", { group: true }));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("shared 群")),
      1000,
      "shared-group denial",
    );

    await host.dispatchCommand(command("fx-owner", { actor: "owner" }));
    await waitFor(() => onebot.texts().includes("owner-only"), 1000, "owner allowed");
  });

  it("injects prompt context through hooks and persists plugin data", async () => {
    const { host, root } = await makeHost({ "hello-fixture": { path: fixture("hello") } });
    const result = await host.beforePrompt(makeIncomingMessage({ text: "hello" }), "demo");
    expect(result.modified).toBe(true);
    expect(result.text).toBe("hello\n\n[fixture-context:demo]");
    expect(result.plugins).toEqual(["hello-fixture"]);

    await host.dispatchCommand(command("fx-store"));
    await host.dispatchCommand(command("fx-store"));
    const state = JSON.parse(
      await readFile(join(root, "plugins", "hello-fixture", "state.json"), "utf8"),
    ) as { count: number };
    expect(state.count).toBe(2);
  });

  it("runs afterRun hooks and emits run.finished events", async () => {
    const { host, root } = await makeHost({ "hello-fixture": { path: fixture("hello") } });
    const now = Date.now();
    const record: RunRecord = {
      id: "run_fixture",
      chatKey: "private:20000",
      projectId: "demo",
      workspaceId: null,
      sessionId: "ses_fixture",
      actorQq: 20000,
      status: "completed",
      startedAt: now,
      finishedAt: null,
      stopReason: null,
      error: null,
      usageJson: null,
    };
    const active: ActiveRun = {
      record,
      message: makeIncomingMessage({ text: "prompt" }),
      permissions: [],
      abort: new AbortController(),
      stopRequested: false,
      interrupted: false,
      agentError: null,
      partialText: "",
      usage: null,
      workspaceId: null,
      workspacePath: null,
    };
    await host.afterRun(active, "completed", null, null);

    const dir = join(root, "plugins", "hello-fixture");
    const lastRun = JSON.parse(await readFile(join(dir, "last-run.json"), "utf8")) as {
      runId: string;
      status: string;
    };
    expect(lastRun).toMatchObject({ runId: "run_fixture", status: "completed" });
    const event = JSON.parse(await readFile(join(dir, "event.json"), "utf8")) as {
      type: string;
    };
    expect(event.type).toBe("run.finished");
  });

  it("reloads plugin config and notifies onConfigReload hooks", async () => {
    const { host, root } = await makeHost({ "hello-fixture": { path: fixture("hello") } });
    await host.configReloaded({ applied: ["plugins"], restartRequired: [] });
    const reload = JSON.parse(
      await readFile(join(root, "plugins", "hello-fixture", "reload.json"), "utf8"),
    ) as { applied: string[] };
    expect(reload.applied).toEqual(["plugins"]);

    const report = await host.reload();
    expect(report.loaded).toBe(1);
    expect(host.status().plugins[0]?.status).toBe("loaded");
  });
});
