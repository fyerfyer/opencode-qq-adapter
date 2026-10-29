import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { ConfigEditor } from "../../src/admin/config-editor.js";
import { AdminConnectionService } from "../../src/admin/connections.js";
import { parseConfigSource } from "../../src/config/loader.js";
import { applyHotConfig } from "../../src/config/reload.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { AuditEntry } from "../../src/domain/audit.js";
import type { HealthService } from "../../src/observability/health.js";
import type { PluginHost, PluginHostStatus, PluginStatus } from "../../src/plugins/host.js";
import { PLUGIN_API_VERSION } from "../../src/plugins/sdk.js";
import { makeTestConfig } from "../helpers/fakes.js";

const roots: string[] = [];
const originalJevKey = process.env.JEV_API_KEY;

afterEach(async () => {
  if (originalJevKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = originalJevKey;
  for (const root of roots.reverse()) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

function pluginStatus(): PluginStatus {
  return {
    id: "roleplay",
    name: "Roleplay",
    version: "0.4.0",
    apiVersion: PLUGIN_API_VERSION,
    description: null,
    status: "loaded",
    error: null,
    capabilities: ["agent"],
    commands: [],
    source: "",
    sourceKind: "path",
    loadedAt: Date.now(),
    admin: { routes: 0, pages: [] },
  };
}

async function makeService(): Promise<{
  service: AdminConnectionService;
  configPath: string;
  config: AppConfig;
  reloads: string[];
  audits: AuditEntry[];
}> {
  const root = await mkdtemp(join(tmpdir(), "qq-connections-"));
  roots.push(root);
  const config = makeTestConfig({ projectPath: root });
  config.storage.plugins_dir = join(root, "plugins");
  config.plugins = {
    roleplay: {
      enabled: true,
      path: join(process.cwd(), "tests/fixtures/plugins/hello"),
      options: { jev_api_key_env: "JEV_API_KEY" },
    },
  };
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, stringify(config), "utf8");
  const reloads: string[] = [];
  const audits: AuditEntry[] = [];
  const editor = new ConfigEditor({
    configPath,
    reload: async () => {
      const source = await readFile(configPath, "utf8");
      const next = await parseConfigSource(source, configPath, { checkPaths: true });
      const applied = applyHotConfig(config, next.config);
      return { ok: true, ...applied, warnings: next.warnings };
    },
    logger: { warn: () => undefined },
  });
  const status: PluginHostStatus = {
    enabled: true,
    total: 1,
    loaded: 1,
    failed: 0,
    plugins: [pluginStatus()],
    message: "",
  };
  const plugins = {
    status: () => status,
    reloadPlugin: async (id: string) => {
      reloads.push(id);
      return "loaded" as const;
    },
  } satisfies Pick<PluginHost, "status" | "reloadPlugin">;
  const health = {
    onebotStatus: () => ({
      mode: "forward" as const,
      connected: true,
      loginOk: true,
      selfId: 3384461856,
      lastEventAt: Date.now(),
      lastConnectedAt: Date.now(),
      lastError: null,
    }),
  } satisfies Pick<HealthService, "onebotStatus">;
  const service = new AdminConnectionService({
    config,
    configPath,
    configEditor: editor,
    health,
    plugins,
    audit: { record: (entry) => audits.push(entry) },
    logger: { warn: () => undefined },
  });
  return { service, configPath, config, reloads, audits };
}

describe("AdminConnectionService plugin secrets", () => {
  it("writes a plugin-referenced secret and reloads that plugin", async () => {
    process.env.JEV_API_KEY = "old-key";
    const { service, configPath, reloads, audits } = await makeService();

    const result = await service.savePluginSecret("roleplay", {
      key: "JEV_API_KEY",
      value: "new-plugin-secret",
    });
    expect(result).toMatchObject({
      key: "JEV_API_KEY",
      configured: true,
      reload: { ok: true },
    });
    expect(process.env.JEV_API_KEY).toBe("new-plugin-secret");
    expect(reloads).toEqual(["roleplay"]);
    expect(await readFile(join(configPath, "..", ".env"), "utf8")).toContain(
      "JEV_API_KEY=new-plugin-secret",
    );
    expect(JSON.stringify(result)).not.toContain("new-plugin-secret");
    expect(audits.find((entry) => entry.action === "admin.plugin.secret.updated")?.detail).toEqual({
      pluginId: "roleplay",
      key: "JEV_API_KEY",
    });
  });

  it("rejects a secret key that is not referenced by the plugin options", async () => {
    const { service } = await makeService();
    await expect(
      service.savePluginSecret("roleplay", { key: "UNRELATED_KEY", value: "secret" }),
    ).rejects.toMatchObject({ code: "plugin_secret_not_referenced" });
  });
});
