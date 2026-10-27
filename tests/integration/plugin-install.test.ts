import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { App } from "../../src/app.js";
import { loadConfig } from "../../src/config/loader.js";
import { buildLogger } from "../../src/observability/logger.js";
import { PLUGIN_API_VERSION } from "../../src/plugins/sdk.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot } from "../helpers/fakes.js";
import { makeZip } from "../helpers/zip.js";

const roots: string[] = [];
const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.reverse()) {
    await app.stop().catch(() => undefined);
  }
  apps.length = 0;
  for (const root of roots.reverse()) {
    await rm(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function pluginZip(id: string, version: string): Promise<Buffer> {
  return makeZip([
    {
      path: "package.json",
      data: JSON.stringify({
        name: id,
        version,
        type: "module",
        opencodeQq: {
          id,
          name: "Integration plugin",
          version,
          apiVersion: PLUGIN_API_VERSION,
          capabilities: ["commands"],
          entry: "./index.js",
        },
      }),
    },
    { path: "index.js", data: "export default { setup() {} };" },
  ]);
}

async function pluginFile(id: string, version: string): Promise<File> {
  return new File([await pluginZip(id, version)], `${id}-${version}.zip`, {
    type: "application/zip",
  });
}

describe("plugin installer integration", () => {
  it("installs, updates, rolls back and uninstalls a managed plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-plugin-install-"));
    roots.push(root);
    const projectPath = join(root, "project");
    const pluginsDir = join(root, "plugins");
    const configPath = join(root, "config.yaml");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      configPath,
      stringify({
        version: 2,
        server: { host: "127.0.0.1", port: 0 },
        onebot: { url: "ws://127.0.0.1:1", access_token: "integration" },
        opencode: { service: { mode: "off", base_url: "http://127.0.0.1:1" } },
        storage: {
          database_path: join(root, "bridge.db"),
          inbox_dir: join(root, "inbox"),
          plugins_dir: pluginsDir,
        },
        workspaces: { root: join(root, "workspaces") },
        default_project: "demo",
        users: {
          "20000": { role: "owner", projects: ["*"], write_projects: ["*"] },
        },
        projects: {
          demo: {
            path: projectPath,
          },
        },
        plugins: {},
        admin: { enabled: true },
        logging: { level: "silent" },
      }),
      "utf8",
    );

    const loaded = await loadConfig(configPath, { checkPaths: true });
    const config = loaded.config;
    config.server.port = 0;
    const store = new SqliteStore(":memory:");
    const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
    const app = new App(config, {
      logger,
      store,
      agent: new FakeAgent(),
      onebot: new FakeOneBot(),
      configPath,
    });
    apps.push(app);
    await app.start();

    const pluginId = "install-fixture";
    const managedPath = join(pluginsDir, ".managed", pluginId);
    const dataPath = join(pluginsDir, pluginId);

    const preview = await app.admin.previewPluginUpload(await pluginFile(pluginId, "0.1.0"));
    expect(preview).toMatchObject({
      uploadId: expect.any(String),
      archive: { name: `${pluginId}-0.1.0.zip` },
      manifest: { id: pluginId, version: "0.1.0" },
      existing: null,
    });

    const installed = await app.admin.installPluginUpload(preview.uploadId ?? "", true);
    expect(installed.plugin).toMatchObject({
      id: pluginId,
      status: "loaded",
      version: "0.1.0",
      sourceKind: "path",
    });
    expect(installed.install).toMatchObject({
      managed: true,
      previousVersion: null,
      archiveName: `${pluginId}-0.1.0.zip`,
    });
    expect(installed.reload.ok).toBe(true);

    const catalog = app.admin.plugins();
    expect(catalog.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
      status: "loaded",
      version: "0.1.0",
      managed: true,
      sourceKind: "path",
    });

    const source = await readFile(configPath, "utf8");
    expect(source).toContain("plugins:");
    expect(source).toContain(managedPath);
    expect((await stat(managedPath)).isDirectory()).toBe(true);

    const reloads: string[] = [];
    const reloadPlugin = app.plugins.reloadPlugin.bind(app.plugins);
    app.plugins.reloadPlugin = async (id: string) => {
      reloads.push(id);
      return reloadPlugin(id);
    };

    const updatePreview = await app.admin.previewPluginUpload(await pluginFile(pluginId, "0.2.0"));
    expect(updatePreview.existing).toMatchObject({
      id: pluginId,
      version: "0.1.0",
      status: "loaded",
      managed: true,
      sourceKind: "path",
    });

    const updated = await app.admin.installPluginUpload(updatePreview.uploadId ?? "", true);
    expect(updated.plugin).toMatchObject({ status: "loaded", version: "0.2.0" });
    expect(updated.install).toMatchObject({
      managed: true,
      previousVersion: "0.1.0",
      backups: 1,
    });
    expect(reloads).toContain(pluginId);
    expect(app.plugins.status().plugins.find((plugin) => plugin.id === pluginId)?.version).toBe(
      "0.2.0",
    );

    const rolledBack = await app.admin.rollbackPlugin(pluginId);
    expect(rolledBack.plugin).toMatchObject({ status: "loaded", version: "0.1.0" });
    expect(JSON.parse(await readFile(join(managedPath, "package.json"), "utf8"))).toMatchObject({
      opencodeQq: { version: "0.1.0" },
    });

    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, "state.json"), "keep", "utf8");

    const removed = await app.admin.uninstallPlugin(pluginId, false);
    expect(removed).toMatchObject({
      configRemoved: true,
      codeRemoved: true,
      dataDeleted: false,
    });
    expect(removed.reload.ok).toBe(true);

    const after = (await loadConfig(configPath, { checkPaths: true })).config;
    expect(after.plugins[pluginId]).toBeUndefined();
    await expect(stat(managedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(dataPath, "state.json"), "utf8")).toBe("keep");

    const audit = app.admin.audit(50) as Array<{ action: string; detail: unknown }>;
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "admin.plugin.installed",
        "admin.plugin.updated",
        "admin.plugin.rolled_back",
        "admin.plugin.uninstalled",
      ]),
    );
    expect(
      audit.find((entry) => entry.action === "admin.plugin.uninstalled")?.detail,
    ).toMatchObject({
      pluginId,
      managed: true,
      deleteData: false,
      codeRemoved: true,
      dataDeleted: false,
    });
  });
});
