import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AuditTrail } from "../../src/observability/audit.js";
import { buildLogger } from "../../src/observability/logger.js";
import { PluginHost } from "../../src/plugins/host.js";
import type {
  AgentMessage,
  AgentPort,
  AgentSession,
  AgentSessionInput,
} from "../../src/ports/agent.js";
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

interface FakeAgentState {
  agent: AgentPort;
  createInputs: AgentSessionInput[];
  prompts: Array<{ sessionId: string; text: string }>;
  deleted: string[];
  interrupted: string[];
  maxActive: number;
  slow: boolean;
}

function makeFakeAgent(options: { slow?: boolean } = {}): FakeAgentState {
  const state: FakeAgentState = {
    agent: {} as AgentPort,
    createInputs: [],
    prompts: [],
    deleted: [],
    interrupted: [],
    maxActive: 0,
    slow: options.slow === true,
  };
  let active = 0;
  let counter = 0;
  const prompts = new Map<string, string>();
  const sessions = new Map<string, AgentSession>();

  state.agent = {
    async start() {},
    async stop() {},
    async health() {
      return {
        healthy: true,
        version: "2.0.32",
        url: "http://test",
        checkedAt: Date.now(),
        error: null,
      };
    },
    async createSession(input: AgentSessionInput): Promise<AgentSession> {
      state.createInputs.push(input);
      counter += 1;
      const session: AgentSession = {
        id: `ses_${counter}`,
        title: input.title ?? null,
        agent: input.agent ?? null,
        model: input.model ?? null,
        projectId: null,
        created: Date.now(),
        updated: Date.now(),
        cost: 0,
        tokens: null,
      };
      sessions.set(session.id, session);
      return session;
    },
    async getSession(sessionId: string) {
      return sessions.get(sessionId) ?? null;
    },
    async deleteSession(sessionId: string) {
      state.deleted.push(sessionId);
      sessions.delete(sessionId);
    },
    async prompt(input) {
      state.prompts.push(input);
      prompts.set(input.sessionId, input.text);
      return { messageId: `msg_${state.prompts.length}`, created: Date.now() };
    },
    async waitForCompletion(sessionId, signal) {
      active += 1;
      state.maxActive = Math.max(state.maxActive, active);
      try {
        if (state.slow) {
          await new Promise<void>((_resolve, reject) => {
            const abort = (): void => reject(new Error("aborted"));
            if (signal?.aborted === true) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        active -= 1;
      }
      if (state.slow) throw new Error(`session ${sessionId} aborted`);
    },
    async interrupt(sessionId: string) {
      state.interrupted.push(sessionId);
      return true;
    },
    async updatePermissions() {},
    async listPermissions() {
      return [];
    },
    async replyPermission() {},
    async listMessages(sessionId: string): Promise<AgentMessage[]> {
      if (state.slow) return [];
      const text = prompts.get(sessionId) ?? "";
      return [
        {
          id: `assistant_${sessionId}`,
          type: "assistant",
          text: `reply:${text}`,
          created: Date.now(),
          error: null,
          cost: 0.01,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ];
    },
    async listModels() {
      return [];
    },
    async listAgents() {
      return [];
    },
    async listSessions() {
      return [];
    },
    async switchModel() {},
    async switchAgent() {},
    async getDiff() {
      return [];
    },
    subscribe() {
      return () => {};
    },
    eventStatus() {
      return { connected: true, lastEventAt: null, lastError: null };
    },
    getLastError() {
      return null;
    },
  };
  return state;
}

async function makeHost(
  plugins: Record<string, string>,
  agent?: AgentPort,
): Promise<{
  host: PluginHost;
  store: SqliteStore;
  onebot: FakeOneBot;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-agent-"));
  const config = makeTestConfig({ projectPath: root });
  config.storage.plugins_dir = join(root, "plugins");
  config.plugins = Object.fromEntries(
    Object.entries(plugins).map(([id, path]) => [id, { enabled: true, path, options: {} }]),
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
    reservedCommands: ["ping", "help"],
    coreVersion: "0.1.1",
    ...(agent !== undefined ? { agent } : {}),
  });
  await host.start();
  disposers.push(async () => {
    await host.stop();
    store.close();
    logger.flush?.();
  });
  return { host, store, onebot, root };
}

function utilityCommand(name = "fx-utility", rawArgs = "hi") {
  const message = makeIncomingMessage({ text: `!${name} ${rawArgs}` });
  return {
    name,
    message,
    args: rawArgs.split(" ").filter(Boolean),
    rawArgs,
    actor: "owner" as const,
    groupMode: null,
  };
}

describe("PluginHost utility agent", () => {
  it("runs a tool-free ephemeral session and audits usage", async () => {
    const fake = makeFakeAgent();
    const { host, store, onebot, root } = await makeHost(
      { "utility-fixture": fixture("utility") },
      fake.agent,
    );

    await host.dispatchCommand(utilityCommand());
    await waitFor(() => onebot.texts().includes("reply:hi"), 1000, "utility reply");

    const pluginDir = join(root, "plugins", "utility-fixture");
    expect(fake.createInputs[0]).toMatchObject({
      directory: pluginDir,
      agent: "helper",
      model: "test/model",
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    expect(fake.prompts[0]?.text).toBe("hi");
    expect(fake.deleted).toEqual(["ses_1"]);
    const audit = store.audit.listRecent(10).find((record) => record.action === "plugin.agent");
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.detail)).toContain("fixture.utility");
    expect(JSON.stringify(audit?.detail)).toContain("costUsd");
  });

  it("serializes utility runs per plugin", async () => {
    const fake = makeFakeAgent();
    const { host, onebot } = await makeHost({ "utility-fixture": fixture("utility") }, fake.agent);
    await host.dispatchCommand(utilityCommand("fx-utility-twice", ""));
    await waitFor(() => onebot.texts().includes("reply:a|reply:b"), 1000, "serialized reply");
    expect(fake.maxActive).toBe(1);
    expect(fake.createInputs).toHaveLength(2);
  });

  it("requires the agent capability in the manifest", async () => {
    const fake = makeFakeAgent();
    const { host, onebot } = await makeHost(
      { "no-agent-fixture": fixture("no-agent") },
      fake.agent,
    );
    await host.dispatchCommand(utilityCommand("fx-no-agent", ""));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("must declare capability 'agent'")),
      1000,
      "capability denial",
    );
    expect(fake.createInputs).toHaveLength(0);
  });

  it("reports a clear error when the bridge has no agent port", async () => {
    const { host, onebot } = await makeHost({
      "utility-fixture": fixture("utility"),
    });
    await host.dispatchCommand(utilityCommand("fx-utility-error", ""));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("utility agent is not available")),
      1000,
      "missing agent error",
    );
  });

  it("aborts in-flight utility runs when the plugin is disposed", async () => {
    const fake = makeFakeAgent({ slow: true });
    const { host, onebot } = await makeHost({ "utility-fixture": fixture("utility") }, fake.agent);
    const pending = host.dispatchCommand(utilityCommand("fx-utility-slow", ""));
    await waitFor(() => fake.createInputs.length === 1, 1000, "slow session created");
    await host.stop();
    await pending;
    expect(fake.interrupted).toEqual(["ses_1"]);
    expect(fake.deleted).toEqual(["ses_1"]);
    expect(onebot.texts().some((text) => text.includes("error:"))).toBe(true);
  });
});
