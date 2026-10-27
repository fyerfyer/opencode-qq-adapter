import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { buildLogger } from "../../src/observability/logger.js";
import { OpenCodeAgent } from "../../src/opencode/agent.js";
import type { AgentEvent } from "../../src/ports/agent.js";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const model = process.env.OPENCODE_TEST_MODEL ?? "opencode-go/deepseek-v4.1-flash";

function waitForEvent(
  agent: OpenCodeAgent,
  type: string,
  sessionId: string,
  timeoutMs = 90_000,
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type} in ${sessionId}`));
    }, timeoutMs);
    const unsubscribe = agent.subscribe((event) => {
      if (event.type !== type || event.sessionId !== sessionId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

describe.skipIf(!enabled)("OpenCode permissions integration", () => {
  it("applies a session ruleset and surfaces permission.asked for QQ approval", async () => {
    const config = configSchema.parse({
      version: 2,
      onebot: { url: "ws://127.0.0.1:3001", access_token: "unused" },
      opencode: {
        service: { mode: "external", version: ">=2.0.0 <3.0.0" },
        default_model: model,
      },
      storage: { database_path: ":memory:" },
    });
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const agent = new OpenCodeAgent(config.opencode, logger);
    const directory = await mkdtemp(join(tmpdir(), "qq-opencode-perm-"));
    try {
      await agent.start();
      const session = await agent.createSession({
        directory,
        title: "permission integration",
        model,
        permissions: [{ action: "shell", resource: "*", effect: "allow" }],
      });
      await agent.updatePermissions(session.id, [
        { action: "*", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "ask" },
        { action: "external_directory", resource: "*", effect: "deny" },
      ]);

      const asked = waitForEvent(agent, "permission.asked", session.id);
      await agent.prompt({
        sessionId: session.id,
        text: "You must use the shell tool to run exactly: echo permission-integration-ok. Then report the output.",
      });
      const event = await asked;
      const data = event.data as {
        id: string;
        sessionID: string;
        action: string;
        resources: string[];
      };
      expect(data.sessionID).toBe(session.id);
      expect(data.action).toBe("shell");
      expect(data.resources.join(" ")).toContain("permission-integration-ok");

      await agent.replyPermission(session.id, data.id, "reject");
      await agent.waitForCompletion(session.id, AbortSignal.timeout(90_000)).catch(() => undefined);
      const pending = await agent.listPermissions(session.id);
      expect(pending).toHaveLength(0);
    } finally {
      await agent.stop();
      logger.flush?.();
    }
  }, 150_000);
});
