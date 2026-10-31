import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    coreVersion: "0.2.0",
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
  };
}

function activeRun(projectId = "demo"): ActiveRun {
  const now = Date.now();
  return {
    record: {
      id: "run_reply_plan",
      chatKey: "private:20000",
      projectId,
      workspaceId: null,
      sessionId: "ses_reply_plan",
      actorQq: 20000,
      status: "running",
      startedAt: now,
      finishedAt: null,
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
    replyText: null,
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

  it("enforces roles and chat types", async () => {
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
      () => onebot.texts().some((text) => text.includes("shared-command")),
      1000,
      "group command allowed",
    );

    await host.dispatchCommand(command("fx-owner", { actor: "owner" }));
    await waitFor(() => onebot.texts().includes("owner-only"), 1000, "owner allowed");
  });

  it("rejects v1 plugin manifests with a clear compatibility error", async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), "qq-v1-plugin-"));
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@fixture/v1",
        version: "0.1.0",
        type: "module",
        opencodeQq: {
          id: "v1-plugin",
          name: "V1 plugin",
          version: "0.1.0",
          apiVersion: 1,
          capabilities: ["commands"],
          entry: "./index.js",
        },
      }),
    );
    await writeFile(join(pluginDir, "index.js"), "export default { setup() {} };\n");

    const { host } = await makeHost({ "v1-plugin": { path: pluginDir } });
    expect(host.status().plugins[0]).toMatchObject({ id: "v1-plugin", status: "failed" });
    expect(host.status().plugins[0]?.error).toContain("plugin API version 1 is not supported");
    expect(host.status().plugins[0]?.error).toContain("apiVersion 2");
  });

  it("fails loading when a plugin touches a capability it did not declare", async () => {
    for (const capability of ["messages", "sessions"] as const) {
      const { host } = await makeHost({
        "undeclared-capability-fixture": {
          path: fixture("undeclared-capability"),
          options: { capability },
        },
      });
      expect(host.status().plugins[0]).toMatchObject({
        id: "undeclared-capability-fixture",
        status: "failed",
      });
      expect(host.status().plugins[0]?.error).toContain(`capability '${capability}'`);
    }
  });

  it("keeps command media and conversation reads behind their capabilities", async () => {
    const { host, onebot } = await makeHost({
      "commands-only-fixture": { path: fixture("commands-only") },
    });

    await host.dispatchCommand(command("fx-no-media"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("capability 'messages'")),
      1000,
      "media capability denial",
    );

    await host.dispatchCommand(command("fx-no-conversation"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("capability 'sessions'")),
      1000,
      "sessions capability denial",
    );
  });

  it("caps plugin-injected prompt context and marks the result as truncated", async () => {
    const { host } = await makeHost({
      "large-context-fixture": {
        path: fixture("large-context"),
        options: { prependChars: 9_000, appendChars: 9_000 },
      },
    });
    const result = await host.beforePrompt(makeIncomingMessage({ text: "hello" }), "demo");
    expect(result.truncated).toBe(true);
    expect(result.originalInjectedChars).toBe(18_004);
    expect(result.injectedChars).toBeLessThanOrEqual(12_000);
    expect(result.text).toContain("插件上下文已截断");
    expect(result.text).toContain("hello");
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

  it("places core prompt context between plugin prepends and the user text", async () => {
    const { host } = await makeHost({ "hello-fixture": { path: fixture("hello") } });
    const result = await host.beforePrompt(
      makeIncomingMessage({ text: "hello" }),
      "demo",
      null,
      "<qq_quote>history</qq_quote>",
    );
    expect(result.text).toBe("<qq_quote>history</qq_quote>\n\nhello\n\n[fixture-context:demo]");
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
      message: makeIncomingMessage({
        text: "prompt",
        quote: {
          id: "quoted_1",
          userId: 20000,
          senderName: "Tester",
          receivedAt: now,
          text: "quoted history",
          images: [],
          unsupported: [],
          available: true,
        },
      }),
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
      quote: { text: string } | null;
    };
    expect(lastRun).toMatchObject({ runId: "run_fixture", status: "completed" });
    expect(lastRun.quote?.text).toBe("quoted history");
    const event = JSON.parse(await readFile(join(dir, "event.json"), "utf8")) as {
      type: string;
    };
    expect(event.type).toBe("run.finished");
  });

  it("resolves ordered text and image reply segments", async () => {
    const { host } = await makeHost({
      "reply-media-fixture": { path: fixture("reply-media"), options: { mode: "mixed" } },
    });
    const plan = await host.formatReply(activeRun(), "final text");
    expect(plan?.suppress).toBeUndefined();
    expect(plan?.segments.map((segment) => segment.kind)).toEqual(["text", "text", "image"]);
    const image = plan?.segments[2];
    expect(image?.kind).toBe("image");
    if (image?.kind === "image") {
      expect(image.dataUri.startsWith("base64://")).toBe(true);
      expect(image.caption).toBe("图注");
      expect(image.mime).toBe("image/png");
      expect(image.bytes).toBeGreaterThan(0);
    }
  });

  it("supports image-only and suppressed reply plans", async () => {
    const { host } = await makeHost({
      "reply-media-fixture": { path: fixture("reply-media"), options: { mode: "image" } },
    });
    const imageOnly = await host.formatReply(activeRun(), "final");
    expect(imageOnly?.segments.map((segment) => segment.kind)).toEqual(["image"]);

    const suppressedHost = await makeHost({
      "reply-media-fixture": {
        path: fixture("reply-media"),
        options: { mode: "suppress" },
      },
    });
    const suppressed = await suppressedHost.host.formatReply(activeRun(), "final");
    expect(suppressed).toEqual({ segments: [], suppress: true });
  });

  it("drops invalid or outside images without leaking the plan", async () => {
    for (const mode of ["escape", "invalid"] as const) {
      const { host } = await makeHost({
        "reply-media-fixture": { path: fixture("reply-media"), options: { mode } },
      });
      const plan = await host.formatReply(activeRun(), "final");
      expect(plan?.segments.map((segment) => segment.kind)).toEqual(["text", "text"]);
    }
  });

  it("caps images per reply", async () => {
    const { host } = await makeHost({
      "reply-media-fixture": { path: fixture("reply-media"), options: { mode: "many" } },
    });
    const plan = await host.formatReply(activeRun(), "final");
    expect(plan?.segments.filter((segment) => segment.kind === "image")).toHaveLength(2);
  });

  it("keeps legacy text-only reply plans working", async () => {
    const { host } = await makeHost({
      "reply-media-fixture": { path: fixture("reply-media"), options: { mode: "legacy" } },
    });
    const plan = await host.formatReply(activeRun(), "final");
    expect(plan?.segments).toEqual([{ kind: "text", text: "legacy" }]);
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

  it("force reloads a plugin from the same path after its code changes", async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), "qq-reload-plugin-"));
    const source = (reply: string) => `export default {
  manifest: {
    id: "reload-plugin",
    name: "Reload fixture",
    version: "0.1.0",
    apiVersion: 2,
    capabilities: ["commands"],
  },
  setup(context) {
    context.commands.register({
      name: "reload-check",
      handler() {
        return ${JSON.stringify(reply)};
      },
    });
  },
};
`;
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "@fixture/reload", version: "0.1.0", type: "module" }),
    );
    await writeFile(join(pluginDir, "index.js"), source("one"));

    const { host, onebot } = await makeHost({ "reload-plugin": { path: pluginDir } });
    expect(host.status().plugins[0]).toMatchObject({ id: "reload-plugin", status: "loaded" });

    expect(await host.dispatchCommand(command("reload-check"))).toBe(true);
    await waitFor(() => onebot.texts().includes("one"), 1000, "first reload-check reply");

    await writeFile(join(pluginDir, "index.js"), source("two"));
    expect(await host.reloadPlugin("reload-plugin")).toBe("loaded");

    expect(await host.dispatchCommand(command("reload-check"))).toBe(true);
    await waitFor(() => onebot.texts().includes("two"), 1000, "second reload-check reply");
    expect(onebot.texts()).toEqual(["one", "two"]);
  });
});
