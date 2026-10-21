import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { configSchema } from "../../src/config/schema.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeOneBot, waitFor } from "../helpers/fakes.js";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const model = process.env.OPENCODE_TEST_MODEL ?? "opencode-go/deepseek-v4.1-flash";
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
    sender: { user_id: 20000, nickname: "Tester" },
  };
}

describe.skipIf(!enabled)("Approval loop with real OpenCode", () => {
  it("turns a real permission.asked into a QQ approval and completes the run", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "qq-approval-loop-"));
    const config = configSchema.parse({
      version: 1,
      server: { port: 0 },
      onebot: { url: "ws://127.0.0.1:3001", access_token: "unused", self_id: 10000 },
      opencode: {
        service: { mode: "external", version: ">=2.0.0 <3.0.0" },
        default_model: model,
      },
      storage: { database_path: ":memory:" },
      default_project: "demo",
      users: { "20000": { role: "owner", projects: ["*"] } },
      projects: { demo: { path: projectPath, policy: "standard" } },
      policies: {
        standard: {
          read: "allow",
          glob: "allow",
          grep: "allow",
          edit: "ask",
          shell: "ask",
          webfetch: "ask",
          websearch: "ask",
          external_directory: "deny",
        },
      },
    });
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const store = new SqliteStore(":memory:");
    const onebot = new FakeOneBot();
    const app = new App(config, { logger, store, onebot });
    disposers.push(async () => {
      await app.stop();
      logger.flush?.();
    });
    await app.start();

    const marker = "approval-loop-ok-731";
    onebot.emit(messageEvent(1, "请只回复 ready，不要使用任何工具。"));
    await waitFor(
      () => typeof app.conversations.getConversation("private:20000")?.sessionId === "string",
      5000,
      "session",
    );
    await waitFor(
      () => onebot.texts().some((text) => text.includes("ready")),
      60_000,
      "initial answer",
    );

    onebot.emit(
      messageEvent(
        2,
        `You must use the shell tool to run exactly: echo ${marker}. Then reply with only the command output.`,
      ),
    );
    await waitFor(
      () => onebot.texts().some((text) => text.includes("需要审批")),
      120_000,
      "approval prompt",
    );
    const prompt = onebot.texts().find((text) => text.includes("需要审批")) ?? "";
    const shortId = /需要审批 #([A-Z0-9]{8})/.exec(prompt)?.[1];
    expect(shortId).toBeTruthy();

    onebot.emit(messageEvent(3, "1"));
    await waitFor(
      () => onebot.texts().some((text) => text.includes("已批准")),
      10_000,
      "approval confirmation",
    );
    await waitFor(
      () => onebot.texts().some((text) => text.includes(marker) && !text.includes("需要审批")),
      120_000,
      "approved command output",
    );
    await waitFor(
      () => app.conversations.status("private:20000").recentRuns[0]?.status === "completed",
      10_000,
      "completed run",
    );

    expect(app.audit.listRecent(50).some((event) => event.action === "approval.requested")).toBe(
      true,
    );
    expect(app.audit.listRecent(50).some((event) => event.action === "approval.resolved")).toBe(
      true,
    );
  }, 240_000);
});
