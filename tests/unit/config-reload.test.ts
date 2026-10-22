import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { App } from "../../src/app.js";
import { loadConfig } from "../../src/config/loader.js";
import { parseEnvFile } from "../../src/config/paths.js";
import { applyHotConfig } from "../../src/config/reload.js";
import { buildLogger } from "../../src/observability/logger.js";
import { runSetup } from "../../src/setup/wizard.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeTestConfig } from "../helpers/fakes.js";

async function configs() {
  const projectPath = await mkdtemp(join(tmpdir(), "qq-reload-"));
  return {
    current: makeTestConfig({ projectPath }),
    next: makeTestConfig({ projectPath }),
  };
}

describe("config hot reload", () => {
  it("replaces user records so deleted users disappear", async () => {
    const { current, next } = await configs();
    current.users["20001"] = { role: "member", projects: ["demo"] };
    next.users = { "20000": { role: "owner", projects: ["*"] } };
    const result = applyHotConfig(current, next);
    expect(result.applied).toContain("users");
    expect(current.users["20001"]).toBeUndefined();
    expect(current.users["20000"]?.role).toBe("owner");
  });

  it("merges object sections in place and removes omitted nested keys", async () => {
    const { current, next } = await configs();
    current.qq.progress_delay_ms = 3000;
    next.qq.progress_delay_ms = 8000;
    current.security.rate_limit.prompts_per_minute = 3;
    next.security.rate_limit = {};
    const result = applyHotConfig(current, next);
    expect(result.applied).toContain("qq");
    expect(result.applied).toContain("security");
    expect(current.qq.progress_delay_ms).toBe(8000);
    expect(current.security.rate_limit.prompts_per_minute).toBeUndefined();
  });

  it("keeps restart-only sections unchanged", async () => {
    const { current, next } = await configs();
    current.onebot.url = "ws://127.0.0.1:3001";
    next.onebot.url = "ws://127.0.0.1:3999";
    next.server.port = 9999;
    next.storage.database_path = "/tmp/other.db";
    const result = applyHotConfig(current, next);
    expect(result.restartRequired).toEqual(expect.arrayContaining(["onebot", "server", "storage"]));
    expect(current.onebot.url).toBe("ws://127.0.0.1:3001");
    expect(current.server.port).not.toBe(9999);
    expect(current.storage.database_path).not.toBe("/tmp/other.db");
  });

  it("reloads an actual App config file without replacing the process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-reload-app-"));
    const setup = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      yes: true,
      skipPlugin: true,
      output: () => undefined,
    });
    const env = parseEnvFile(await readFile(setup.envPath, "utf8"));
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const loaded = await loadConfig(setup.configPath, { checkPaths: true });
      loaded.config.logging.level = "silent";
      const store = new SqliteStore(":memory:");
      const logger = buildLogger(loaded.config, {
        env: { NODE_ENV: "test", LOG_LEVEL: "silent" },
      });
      const app = new App(loaded.config, {
        logger,
        store,
        agent: new FakeAgent(),
        onebot: new FakeOneBot(),
        configPath: setup.configPath,
      });
      try {
        const raw = parseYaml(await readFile(setup.configPath, "utf8")) as {
          users: Record<string, unknown>;
        };
        raw.users["99999"] = { role: "member", projects: ["demo"] };
        await writeFile(setup.configPath, stringifyYaml(raw));
        const result = await app.reloadConfig();
        expect(result.ok).toBe(true);
        expect(result.applied).toContain("users");
        expect(app.config.users["99999"]?.role).toBe("member");
      } finally {
        await app.stop();
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("applies non-service OpenCode fields and flags service changes", async () => {
    const { current, next } = await configs();
    const oldBaseUrl = current.opencode.service.base_url;
    next.opencode.default_model = "fake/model-b";
    next.opencode.service.base_url = "http://127.0.0.1:9999";
    const result = applyHotConfig(current, next);
    expect(result.applied).toContain("opencode.default_model");
    expect(result.restartRequired).toContain("opencode.service");
    expect(current.opencode.default_model).toBe("fake/model-b");
    expect(current.opencode.service.base_url).toBe(oldBaseUrl);
  });
});
