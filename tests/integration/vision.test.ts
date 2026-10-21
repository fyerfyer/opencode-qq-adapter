import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { buildLogger } from "../../src/observability/logger.js";
import { OpenCodeAgent } from "../../src/opencode/agent.js";

const enabled = process.env.OPENCODE_VISION_INTEGRATION === "1";
const model = process.env.OPENCODE_TEST_MODEL ?? "opencode-go/deepseek-v4.1-flash";

// 96x96 solid red PNG generated with ImageMagick.
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgAQMAAADYVuV7AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABlBMVEX/AAD///9BHTQRAAAAAWJLR0QB/wIt3gAAAAd0SU1FB+oKFQUZKhAMj20AAAASSURBVDjLY2AYBaNgFIyC4QkABOAAAdL37nQAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMTAtMjFUMDU6MjU6NDIrMDA6MDDR4dgnAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTEwLTIxVDA1OjI1OjQyKzAwOjAwoLxgmwAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!enabled)("OpenCode vision integration", () => {
  it("reads an attached local image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qq-vision-"));
    const imagePath = join(directory, "red.png");
    await writeFile(imagePath, RED_PNG);
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
    try {
      await agent.start();
      const session = await agent.createSession({
        directory,
        title: "vision",
        model,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      await agent.prompt({
        sessionId: session.id,
        text: "The attached image is a solid color. Reply with just the color name in English.",
        files: [{ uri: `file://${imagePath}`, name: "red.png" }],
      });
      await agent.waitForCompletion(session.id, AbortSignal.timeout(120_000));
      const messages = await agent.listMessages(session.id, 20);
      const assistant = messages.find((message) => message.type === "assistant");
      expect(assistant?.text.toLowerCase()).toContain("red");
    } finally {
      await agent.stop();
      logger.flush?.();
    }
  }, 120_000);
});
