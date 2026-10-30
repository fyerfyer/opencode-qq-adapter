import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { configSchema } from "../../src/config/schema.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeOneBot, waitFor } from "../helpers/fakes.js";

const enabled = process.env.OPENCODE_PLUGIN_INTEGRATION === "1";
const baseUrl = process.env.OPENCODE_PLUGIN_BASE_URL ?? "http://127.0.0.1:4096";
const password = process.env.OPENCODE_PLUGIN_PASSWORD ?? "";
const bridgePort = Number(process.env.OPENCODE_PLUGIN_BRIDGE_PORT ?? "18787");
const internalToken = process.env.QQ_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";
const model = process.env.OPENCODE_TEST_MODEL ?? "opencode-go/deepseek-v4.1-flash";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

describe.skipIf(!enabled)("OpenCode plugin media integration", () => {
  it("invokes qq_send_image and forwards the image to QQ", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "qq-plugin-e2e-"));
    await writeFile(join(projectPath, "chart.png"), PNG);
    const config = configSchema.parse({
      version: 2,
      server: { host: "127.0.0.1", port: bridgePort, internal_token: internalToken },
      onebot: { url: "ws://127.0.0.1:3001", access_token: "unused" },
      opencode: {
        service: {
          mode: "off",
          base_url: baseUrl,
          username: "opencode",
          password,
          version: ">=2.0.0 <3.0.0",
        },
        default_model: model,
      },
      storage: { database_path: ":memory:", inbox_dir: join(projectPath, ".inbox") },
      default_project: "demo",
      users: {
        "20000": { role: "owner", projects: ["*"], write_projects: ["*"] },
      },
      projects: {
        demo: { path: projectPath, workspace: "shared" },
      },
    });
    const store = new SqliteStore(":memory:");
    const onebot = new FakeOneBot();
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const app = new App(config, { logger, store, onebot });
    try {
      await app.start();
      const workspace = app.workspaces.status("demo").workspace;
      const session = await app.agent.createSession({
        directory: projectPath,
        title: "plugin e2e",
        model,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      store.conversations.upsert({
        chatKey: "private:20000",
        projectId: "demo",
        workspaceId: workspace?.id ?? null,
        sessionId: session.id,
        actorQq: 20000,
        agent: null,
        model,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });

      await app.agent.prompt({
        sessionId: session.id,
        text:
          "Call the qq_send_image tool exactly once with path 'chart.png' and caption " +
          "'plugin-e2e'. Do not use the shell. After the tool succeeds, reply 'done'.",
      });
      await app.agent.waitForCompletion(session.id, AbortSignal.timeout(180_000));

      await waitFor(
        () =>
          onebot.sent.some((message) =>
            message.segments.some((segment) => segment.type === "image"),
          ),
        10_000,
        "image segment",
      );
      const sent = onebot.sent.find((message) =>
        message.segments.some((segment) => segment.type === "image"),
      );
      expect(sent?.chat?.chatKey).toBe("private:20000");
    } finally {
      await app.stop();
      logger.flush?.();
    }
  }, 240_000);
});
