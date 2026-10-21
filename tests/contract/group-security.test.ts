import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig, waitFor } from "../helpers/fakes.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

function groupEvent(options: {
  id: number;
  groupId: number;
  userId: number;
  text: string;
  mention?: boolean;
}): Record<string, unknown> {
  const message: unknown[] = [];
  if (options.mention !== false) {
    message.push({ type: "at", data: { qq: "10000" } });
  }
  message.push({ type: "text", data: { text: options.text } });
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 10000,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: options.id,
    group_id: options.groupId,
    user_id: options.userId,
    message,
    raw_message: options.text,
    sender: { user_id: options.userId, nickname: `User${options.userId}` },
  };
}

async function startApp(mutate: (config: ReturnType<typeof makeTestConfig>) => void) {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-group-"));
  const config = makeTestConfig({ projectPath });
  config.server.port = 0;
  config.users["20001"] = { role: "member", projects: ["demo"] };
  config.users["20002"] = { role: "member", projects: ["demo"] };
  config.projects.demo = {
    ...config.projects.demo,
    allowed_users: ["20000", "20001", "20002"],
  };
  mutate(config);
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
  return { app, config, store, agent, onebot, projectPath };
}

describe("Group isolation and security", () => {
  it("isolates per_user group conversations while sharing the workspace", async () => {
    const { config, store, agent, onebot } = await startApp((config) => {
      config.groups["30001"] = {
        enabled: true,
        mode: "per_user",
        require_mention: true,
        allowed_users: ["20000", "20001"],
        projects: ["demo"],
      };
    });
    void config;
    onebot.emit(groupEvent({ id: 1, groupId: 30001, userId: 20000, text: "hello from owner" }));
    await waitFor(() => agent.prompts.length === 1, 3000, "first group prompt");
    onebot.emit(groupEvent({ id: 2, groupId: 30001, userId: 20001, text: "hello from member" }));
    await waitFor(() => agent.prompts.length === 2, 3000, "second group prompt");

    expect(store.conversations.get("group:30001:20000")?.sessionId).not.toBeNull();
    expect(store.conversations.get("group:30001:20001")?.sessionId).not.toBeNull();
    expect(store.conversations.get("group:30001:20000")?.sessionId).not.toBe(
      store.conversations.get("group:30001:20001")?.sessionId,
    );
    expect(store.conversations.get("group:30001")).toBeNull();
    expect(store.workspaces.get("shared:demo")?.status).toBe("idle");
  });

  it("shares one conversation in shared group mode", async () => {
    const { store, agent, onebot } = await startApp((config) => {
      config.groups["30003"] = {
        enabled: true,
        mode: "shared",
        require_mention: true,
        allowed_users: ["20000", "20001"],
        projects: ["demo"],
      };
    });
    onebot.emit(groupEvent({ id: 3, groupId: 30003, userId: 20000, text: "hello" }));
    await waitFor(() => agent.prompts.length === 1, 3000, "shared prompt");
    onebot.emit(groupEvent({ id: 4, groupId: 30003, userId: 20001, text: "again" }));
    await waitFor(() => agent.prompts.length === 2, 3000, "shared prompt 2");

    expect(store.conversations.get("group:30003")).not.toBeNull();
    expect(store.conversations.get("group:30003:20000")).toBeNull();
    expect(agent.sessionInputs).toHaveLength(1);
  });

  it("forces write tools to deny in readonly groups", async () => {
    const { agent, onebot } = await startApp((config) => {
      config.groups["30002"] = {
        enabled: true,
        mode: "readonly",
        require_mention: true,
        allowed_users: ["20000"],
        projects: ["demo"],
      };
    });
    onebot.emit(groupEvent({ id: 5, groupId: 30002, userId: 20000, text: "hello" }));
    await waitFor(() => agent.prompts.length === 1, 3000, "readonly prompt");
    const rules = agent.sessionInputs[0]?.permissions ?? [];
    for (const action of ["edit", "write", "shell", "external_directory"]) {
      const matching = rules.filter((rule) => rule.action === action);
      expect(matching.at(-1)?.effect).toBe("deny");
    }
  });

  it("silently ignores non-allowlisted users and groups", async () => {
    const { app, onebot } = await startApp((config) => {
      config.groups["30001"] = {
        enabled: true,
        mode: "per_user",
        require_mention: true,
        allowed_users: ["20000"],
        projects: ["demo"],
      };
    });
    onebot.emit(groupEvent({ id: 6, groupId: 30001, userId: 20002, text: "hello" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    onebot.emit(groupEvent({ id: 7, groupId: 39999, userId: 20000, text: "hello" }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(onebot.sent).toHaveLength(0);
    const actions = app.audit.listRecent(10).map((entry) => entry.action);
    expect(actions.filter((action) => action === "access.denied").length).toBeGreaterThanOrEqual(2);
  });

  it("ignores unmentioned group chatter when require_mention is on", async () => {
    const { agent, onebot } = await startApp((config) => {
      config.groups["30001"] = {
        enabled: true,
        mode: "per_user",
        require_mention: true,
        allowed_users: ["20000"],
        projects: ["demo"],
      };
    });
    onebot.emit(
      groupEvent({ id: 8, groupId: 30001, userId: 20000, text: "not for the bot", mention: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(agent.prompts).toHaveLength(0);
    expect(onebot.sent).toHaveLength(0);
  });
});
