import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { buildLogger } from "../../src/observability/logger.js";
import { OpenCodeAgent } from "../../src/opencode/agent.js";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const model = process.env.OPENCODE_TEST_MODEL ?? "opencode-go/deepseek-v4.1-flash";

describe.skipIf(!enabled)("OpenCode integration", () => {
  it("creates a session, runs a prompt and collects the assistant text", async () => {
    const config = configSchema.parse({
      version: 1,
      onebot: { url: "ws://127.0.0.1:3001", access_token: "unused" },
      opencode: {
        service: { mode: "external", version: ">=2.0.0 <3.0.0" },
        default_model: model,
      },
      storage: { database_path: ":memory:" },
    });
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const agent = new OpenCodeAgent(config.opencode, logger);
    const directory = await mkdtemp(join(tmpdir(), "qq-opencode-"));
    try {
      await agent.start();
      const health = await agent.health(true);
      expect(health.healthy).toBe(true);
      expect(health.version).toBe("2.0.32");

      const session = await agent.createSession({ directory, title: "integration", model });
      const receipt = await agent.prompt({
        sessionId: session.id,
        text: "Reply with exactly: pong-from-opencode",
      });
      await agent.waitForCompletion(session.id, AbortSignal.timeout(120_000));
      const messages = await agent.listMessages(session.id, 20);
      const assistant = messages.find((message) => message.type === "assistant");
      expect(assistant?.text).toContain("pong-from-opencode");
      expect(receipt.messageId).toMatch(/^msg_/);
    } finally {
      await agent.stop();
      logger.flush?.();
    }
  });
});
