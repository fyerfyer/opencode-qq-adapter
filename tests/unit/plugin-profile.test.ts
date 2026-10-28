import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveRun } from "../../src/conversation/types.js";
import type { RunRecord } from "../../src/domain/conversation.js";
import { AuditTrail } from "../../src/observability/audit.js";
import { buildLogger } from "../../src/observability/logger.js";
import { normalizePluginProfile } from "../../src/plugins/host/profile.js";
import { PluginHost, type PluginSessionActions } from "../../src/plugins/host.js";
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

async function makeHost(options: { directory?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qq-profile-host-"));
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
  };
  config.plugins = {
    "profile-fixture": {
      enabled: true,
      path: fixture("profile"),
      options: { directory: options.directory ?? persona },
    },
  };

  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const audit = new AuditTrail(store, logger);
  const sessionCalls: Array<Record<string, unknown>> = [];
  const sessionActions: PluginSessionActions = {
    setProject(input) {
      sessionCalls.push({ action: "setProject", ...input });
      return { ok: true };
    },
    reset(input) {
      sessionCalls.push({ action: "reset", ...input });
      return { ok: true };
    },
  };
  const host = new PluginHost({
    config,
    logger,
    audit,
    sender,
    conversations: { getConversation: () => null },
    sessionActions,
    reservedCommands: ["ping", "help"],
    coreVersion: "0.1.1",
  });
  await host.start();
  disposers.push(async () => {
    await host.stop();
    store.close();
    logger.flush?.();
  });
  return { host, onebot, sessionCalls, persona, root, config, logger };
}

function activeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  const record: RunRecord = {
    id: "run_profile",
    chatKey: "private:20000",
    projectId: "demo",
    workspaceId: null,
    sessionId: "ses_profile",
    actorQq: 20000,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    stopReason: null,
    error: null,
    usageJson: null,
  };
  return {
    record,
    message: makeIncomingMessage({ text: "hello from fixture" }),
    rawText: "raw hello",
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
    ...overrides,
  };
}

describe("PluginHost conversation profile", () => {
  it("resolves a validated profile and exposes it to prompt hooks", async () => {
    const { host, persona } = await makeHost();
    const message = makeIncomingMessage({ text: "你好" });
    const result = await host.resolveProfile(message, "demo");
    expect(result.plugins).toEqual(["profile-fixture"]);
    expect(result.profile).toEqual({ directory: persona });
  });

  it("ignores plugin-supplied agent, model and workspace fields", async () => {
    const { config, logger, persona } = await makeHost();
    const profile = await normalizePluginProfile({
      raw: { directory: persona, agent: "x", model: "y", workspace: "none" },
      projectId: "demo",
      pluginId: "profile-fixture",
      config,
      logger,
    });
    expect(profile).toEqual({ directory: persona });
    expect(profile).not.toHaveProperty("agent");
    expect(profile).not.toHaveProperty("model");
    expect(profile).not.toHaveProperty("workspace");
  });

  it("rejects a profile directory outside the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-profile-outside-"));
    const { host } = await makeHost({ directory: root });
    const result = await host.resolveProfile(makeIncomingMessage(), "demo");
    expect(result.profile).toBeNull();
    expect(result.plugins).toEqual([]);
  });

  it("turns a plugin reply plan into ordered segments", async () => {
    const { host } = await makeHost();
    const active = activeRun();
    const plan = await host.formatReply(active, "一二三四五六");
    expect(plan).toEqual({
      segments: [
        { kind: "text", text: "一二三" },
        { kind: "text", text: "四五六", delayMs: 5 },
      ],
    });
  });

  it("passes user and assistant text to afterRun", async () => {
    const { host, root } = await makeHost();
    const active = activeRun({ rawText: "raw question", replyText: "raw answer" });
    await host.afterRun(active, "completed", null, null);
    const saved = JSON.parse(
      await readFile(join(root, "plugins", "profile-fixture", "last-run.json"), "utf8"),
    ) as { userText: string; replyText: string };
    expect(saved).toEqual({ userText: "raw question", replyText: "raw answer" });
  });

  it("routes plugin session mutations through the guarded core actions", async () => {
    const { host, sessionCalls, onebot } = await makeHost();
    const message = makeIncomingMessage({ text: "!fx-session" });
    const handled = await host.dispatchCommand({
      name: "fx-session",
      message,
      args: [],
      rawArgs: "",
      actor: "owner",
      groupMode: null,
    });
    expect(handled).toBe(true);
    await waitFor(() => onebot.texts().includes("session-ok"), 1000, "session command reply");
    expect(sessionCalls).toEqual([
      {
        action: "setProject",
        chatKey: "private:20000",
        projectId: "demo",
        actorQq: 20000,
      },
      { action: "reset", chatKey: "private:20000", actorQq: 20000 },
    ]);
  });
});
