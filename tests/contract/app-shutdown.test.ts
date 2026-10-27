import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { App } from "../../src/app.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig } from "../helpers/fakes.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function waitForPortClosed(port: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`HTTP port ${port} was not released within ${timeoutMs}ms`);
}

describe("App shutdown", () => {
  it("releases the HTTP port before slower OneBot cleanup finishes", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "qq-shutdown-"));
    const config = makeTestConfig({ projectPath });
    config.server.port = 0;
    const store = new SqliteStore(":memory:");
    const agent = new FakeAgent();
    const onebot = new FakeOneBot();
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const app = new App(config, { logger, store, agent, onebot });
    await app.start();
    const port = app.httpPort;
    disposers.push(async () => {
      await app.stop();
      logger.flush?.();
    });

    let release!: () => void;
    onebot.stopGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopping = app.stop();
    try {
      await waitForPortClosed(port);
    } finally {
      release();
      await stopping;
    }
  });
});
