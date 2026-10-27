import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigEditor } from "../../src/admin/config-editor.js";
import { parseConfigSource } from "../../src/config/loader.js";
import { applyHotConfig } from "../../src/config/reload.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { PluginHost, PluginRuntimeStatus, PluginStatus } from "../../src/plugins/host.js";
import { PluginInstaller } from "../../src/plugins/install/installer.js";
import { PLUGIN_ARCHIVE_LIMITS, PluginInstallError } from "../../src/plugins/install/types.js";
import { PLUGIN_API_VERSION } from "../../src/plugins/sdk.js";
import { makeZip } from "../helpers/zip.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.reverse()) {
    await rm(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function silentLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function configSource(pluginsBlock = "plugins: {}"): string {
  return `version: 1
onebot:
  url: "ws://127.0.0.1:3001"
  access_token: "test"
opencode:
  service:
    mode: "off"
    base_url: "http://127.0.0.1:1"
storage:
  database_path: "var/bot.db"
  inbox_dir: "var/inbox"
  plugins_dir: "plugins"
workspaces:
  root: "var/workspaces"
default_project: "demo"
users:
  "20000":
    role: "owner"
    projects: ["*"]
projects:
  demo:
    path: "."
${pluginsBlock}
`;
}

async function writePluginPackage(
  root: string,
  id: string,
  version: string,
  options: { entry?: string; extra?: Record<string, unknown> } = {},
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const entry = options.entry ?? "./index.js";
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: id,
      version,
      type: "module",
      opencodeQq: {
        id,
        name: `Plugin ${id}`,
        version,
        apiVersion: PLUGIN_API_VERSION,
        capabilities: ["commands"],
        entry,
        ...options.extra,
      },
    }),
    "utf8",
  );
  if (entry.endsWith(".js")) {
    await writeFile(join(dir, "index.js"), "export default { setup() {} };", "utf8");
  }
  return dir;
}

async function pluginZip(
  id: string,
  version: string,
  options: { extra?: Record<string, unknown> } = {},
): Promise<Buffer> {
  return makeZip([
    {
      path: "package.json",
      data: JSON.stringify({
        name: id,
        version,
        type: "module",
        opencodeQq: {
          id,
          name: `Plugin ${id}`,
          version,
          apiVersion: PLUGIN_API_VERSION,
          capabilities: ["commands"],
          entry: "./index.js",
          ...options.extra,
        },
      }),
    },
    { path: "index.js", data: "export default { setup() {} };" },
  ]);
}

interface Harness {
  root: string;
  configPath: string;
  pluginsDir: string;
  config: AppConfig;
  editor: ConfigEditor;
  installer: PluginInstaller;
  reloads: string[];
  statuses: Map<string, PluginStatus>;
  failReloads: Set<string>;
  failReloadOnce: Set<string>;
}

async function makeHarness(
  options: { pluginsBlock?: string; now?: () => number; started?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-installer-"));
  roots.push(root);
  const configPath = join(root, "config.yaml");
  const source = configSource(options.pluginsBlock);
  await writeFile(configPath, source, "utf8");
  const loaded = await parseConfigSource(source, configPath, { checkPaths: true });
  const config = loaded.config;
  const pluginsDir = config.storage.plugins_dir;
  const statuses = new Map<string, PluginStatus>();
  const reloads: string[] = [];
  const failReloads = new Set<string>();
  const failReloadOnce = new Set<string>();

  const deriveStatus = async (id: string): Promise<PluginStatus> => {
    const entry = config.plugins[id];
    if (entry === undefined) throw new Error(`unknown plugin: ${id}`);
    const sourcePath = entry.path ?? entry.package ?? "";
    let name = id;
    let version = "-";
    let description: string | null = null;
    let capabilities: string[] = [];
    let status: PluginRuntimeStatus = "disabled";
    let error: string | null = null;
    if (entry.enabled) {
      try {
        const packageJsonPath = join(sourcePath, "package.json");
        const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          !("opencodeQq" in parsed) ||
          parsed.opencodeQq === null ||
          typeof parsed.opencodeQq !== "object"
        ) {
          throw new Error("missing opencodeQq manifest");
        }
        const manifest = parsed.opencodeQq as Record<string, unknown>;
        name = typeof manifest.name === "string" ? manifest.name : id;
        version = typeof manifest.version === "string" ? manifest.version : "-";
        description = typeof manifest.description === "string" ? manifest.description : null;
        capabilities = Array.isArray(manifest.capabilities)
          ? manifest.capabilities.filter((item): item is string => typeof item === "string")
          : [];
        const manifestEntry = typeof manifest.entry === "string" ? manifest.entry : "./index.js";
        const entryPath = join(sourcePath, manifestEntry);
        const info = await stat(entryPath);
        if (!info.isFile()) throw new Error("plugin entry is not a file");
        status = "loaded";
      } catch (loadError) {
        status = "failed";
        error = loadError instanceof Error ? loadError.message : String(loadError);
      }
    }
    return {
      id,
      name,
      version,
      apiVersion: PLUGIN_API_VERSION,
      description,
      status,
      error,
      capabilities,
      commands: [],
      source: sourcePath,
      sourceKind: entry.package === undefined ? "path" : "package",
      loadedAt: status === "loaded" ? Date.now() : null,
      admin: { routes: 0, pages: [] },
    };
  };

  const refresh = async (): Promise<void> => {
    const configured = new Set(Object.keys(config.plugins));
    for (const id of [...statuses.keys()]) {
      if (!configured.has(id)) statuses.delete(id);
    }
    for (const id of configured) {
      statuses.set(id, await deriveStatus(id));
    }
  };

  await refresh();

  const host = {
    started: options.started ?? true,
    status: () => {
      const plugins = [...statuses.values()];
      const loadedCount = plugins.filter((plugin) => plugin.status === "loaded").length;
      const failedCount = plugins.filter((plugin) => plugin.status === "failed").length;
      return {
        enabled: true,
        total: plugins.length,
        loaded: loadedCount,
        failed: failedCount,
        plugins,
        message: "",
      };
    },
    reloadPlugin: async (id: string): Promise<PluginRuntimeStatus> => {
      reloads.push(id);
      if (config.plugins[id] === undefined) throw new Error(`unknown plugin: ${id}`);
      if (failReloads.has(id) || failReloadOnce.delete(id)) {
        throw new Error("simulated reload failure");
      }
      const status = await deriveStatus(id);
      statuses.set(id, status);
      return status.status;
    },
  } satisfies Pick<PluginHost, "status" | "reloadPlugin" | "started">;

  const editor = new ConfigEditor({
    configPath,
    reload: async () => {
      const nextSource = await readFile(configPath, "utf8");
      const next = await parseConfigSource(nextSource, configPath, { checkPaths: true });
      const { applied, restartRequired } = applyHotConfig(config, next.config);
      await refresh();
      return { ok: true, applied, restartRequired, warnings: next.warnings };
    },
    logger: { warn: () => undefined },
  });

  const installer = new PluginInstaller({
    config,
    configPath,
    configEditor: editor,
    host,
    coreVersion: "0.1.1",
    logger: silentLogger(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    root,
    configPath,
    pluginsDir,
    config,
    editor,
    installer,
    reloads,
    statuses,
    failReloads,
    failReloadOnce,
  };
}

async function readConfig(path: string): Promise<AppConfig> {
  const source = await readFile(path, "utf8");
  return (await parseConfigSource(source, path, { checkPaths: true })).config;
}

async function expectInstallError(promise: Promise<unknown>, code: string, status?: number) {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PluginInstallError);
  expect(error).toMatchObject({
    code,
    ...(status === undefined ? {} : { status }),
  });
}

describe("PluginInstaller", () => {
  it("installs a new upload under .managed and writes the YAML path", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    expect(preview.uploadId).not.toBeNull();
    expect(preview.manifest).toMatchObject({
      id: "demo",
      version: "0.1.0",
      engines: { opencodeQq: null },
    });
    expect(preview.existing).toBeNull();
    expect(preview.configHash).not.toBeNull();
    expect(preview.configPath).toBe(harness.configPath);

    const result = await harness.installer.installUpload(preview.uploadId ?? "", true);
    const target = join(harness.pluginsDir, ".managed", "demo");
    expect(result.plugin.status).toBe("loaded");
    expect(result.plugin.version).toBe("0.1.0");
    expect(result.plugin.managed).toBe(true);
    expect(result.install).toMatchObject({
      managed: true,
      sourceKind: "path",
      archiveName: "demo.zip",
      previousVersion: null,
      backups: 0,
    });
    expect(result.install?.archiveSha256).toBe(preview.archive?.sha256);
    expect(result.reload.ok).toBe(true);

    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      opencodeQq: { version: string };
    };
    expect(packageJson.opencodeQq.version).toBe("0.1.0");
    const installMeta = JSON.parse(
      await readFile(join(target, ".opencode-qq-install.json"), "utf8"),
    ) as { archiveName: string; archiveSha256: string };
    expect(installMeta.archiveName).toBe("demo.zip");
    expect(installMeta.archiveSha256).toBe(preview.archive?.sha256);

    const config = await readConfig(harness.configPath);
    expect(config.plugins.demo).toMatchObject({ enabled: true, path: target });
    expect(harness.statuses.get("demo")?.status).toBe("loaded");
  });

  it("creates the plugins section when the config file does not have one", async () => {
    const harness = await makeHarness({ pluginsBlock: "" });
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    const result = await harness.installer.installUpload(preview.uploadId ?? "", true);
    expect(result.plugin.status).toBe("loaded");
    const config = await readConfig(harness.configPath);
    expect(config.plugins.demo).toMatchObject({
      enabled: true,
      path: join(harness.pluginsDir, ".managed", "demo"),
    });
  });

  it("can install a plugin without enabling it", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    const result = await harness.installer.installUpload(preview.uploadId ?? "", false);
    expect(result.plugin).toMatchObject({ status: "disabled", managed: true });
    expect((await readConfig(harness.configPath)).plugins.demo).toMatchObject({
      enabled: false,
      path: join(harness.pluginsDir, ".managed", "demo"),
    });
  });

  it("keeps managed code and data when uninstall reload fails", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await harness.installer.installUpload(preview.uploadId ?? "", true);
    const target = join(harness.pluginsDir, ".managed", "demo");
    const dataDir = join(harness.pluginsDir, "demo");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "keep.txt"), "keep", "utf8");

    const snapshot = await harness.editor.read();
    harness.editor.mutate = async () => ({
      ...snapshot,
      backup: null,
      applied: [],
      restartRequired: [],
      reload: {
        ok: false,
        applied: [],
        restartRequired: [],
        warnings: ["simulated reload failure"],
        error: "simulated reload failure",
      },
    });

    const result = await harness.installer.uninstall("demo", true);
    expect(result).toMatchObject({
      configRemoved: true,
      codeRemoved: false,
      dataDeleted: false,
    });
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await readFile(join(dataDir, "keep.txt"), "utf8")).toBe("keep");
  });

  it("restores the previous version when the config hash conflicts during install", async () => {
    const harness = await makeHarness();
    const first = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo-1.zip",
    });
    await harness.installer.installUpload(first.uploadId ?? "", true);
    const second = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo-2.zip",
    });

    await expectInstallError(
      harness.installer.installUpload(second.uploadId ?? "", true, "stale-hash"),
      "install_failed",
      409,
    );

    const target = join(harness.pluginsDir, ".managed", "demo");
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      opencodeQq: { version: string };
    };
    expect(packageJson.opencodeQq.version).toBe("0.1.0");
    expect(await readdir(join(harness.pluginsDir, ".managed", ".backups", "demo"))).toEqual([]);
    expect((await readConfig(harness.configPath)).plugins.demo?.path).toBe(target);
    expect(harness.reloads).toEqual([]);
  });

  it("updates a managed plugin, keeps a backup and forces a reload", async () => {
    const harness = await makeHarness();
    const first = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo-1.zip",
    });
    await harness.installer.installUpload(first.uploadId ?? "", true);
    await harness.editor.mutate((document) => {
      document.setIn(["plugins", "demo", "options"], { token: "keep" });
    });
    harness.reloads.length = 0;

    const second = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo-2.zip",
    });
    expect(second.existing).toMatchObject({
      id: "demo",
      version: "0.1.0",
      managed: true,
      status: "loaded",
    });
    const result = await harness.installer.installUpload(second.uploadId ?? "", true);

    expect(harness.reloads).toEqual(["demo"]);
    expect(result.plugin).toMatchObject({ status: "loaded", version: "0.2.0", managed: true });
    expect(result.install).toMatchObject({ managed: true, previousVersion: "0.1.0", backups: 1 });

    const target = join(harness.pluginsDir, ".managed", "demo");
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      opencodeQq: { version: string };
    };
    expect(packageJson.opencodeQq.version).toBe("0.2.0");

    const backups = await readdir(join(harness.pluginsDir, ".managed", ".backups", "demo"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/0\.1\.0$/);
    expect((await readConfig(harness.configPath)).plugins.demo).toMatchObject({
      path: target,
      options: { token: "keep" },
    });
  });

  it("rejects an upload whose id is already configured from an external path", async () => {
    const root = await mkdtemp(join(tmpdir(), "qq-plugin-installer-external-"));
    roots.push(root);
    const external = await writePluginPackage(join(root, "external"), "demo", "0.1.0");
    const harness = await makeHarness({
      pluginsBlock: `plugins:\n  demo:\n    enabled: true\n    path: ${JSON.stringify(external)}`,
    });

    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo.zip",
    });
    expect(preview.existing).toMatchObject({
      id: "demo",
      managed: false,
      sourceKind: "path",
      version: "0.1.0",
    });
    await expectInstallError(
      harness.installer.installUpload(preview.uploadId ?? "", true),
      "package_conflict",
      409,
    );
    await expect(stat(join(harness.pluginsDir, ".managed", "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(harness.reloads).toEqual([]);
  });

  it("rolls back to the newest backup and restores the previous version", async () => {
    const harness = await makeHarness();
    const first = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo-1.zip",
    });
    await harness.installer.installUpload(first.uploadId ?? "", true);
    const second = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo-2.zip",
    });
    await harness.installer.installUpload(second.uploadId ?? "", true);
    harness.reloads.length = 0;

    const result = await harness.installer.rollback("demo");
    expect(result.plugin).toMatchObject({ status: "loaded", version: "0.1.0", managed: true });
    expect(result.install).toMatchObject({ managed: true, backups: 0 });
    expect(result.reload.ok).toBe(true);
    expect(harness.reloads).toEqual(["demo"]);

    const target = join(harness.pluginsDir, ".managed", "demo");
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      opencodeQq: { version: string };
    };
    expect(packageJson.opencodeQq.version).toBe("0.1.0");
  });

  it("rejects rollback when there is no backup", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await harness.installer.installUpload(preview.uploadId ?? "", true);
    await expectInstallError(harness.installer.rollback("demo"), "no_backup", 409);
  });

  it("rolls back to the newest backup even when versions do not sort lexicographically", async () => {
    const harness = await makeHarness({ now: () => 1_700_000_000_000 });
    for (const version of ["0.9.0", "0.10.0", "1.0.0"]) {
      const preview = await harness.installer.previewUpload({
        buffer: await pluginZip("demo", version),
        filename: `demo-${version}.zip`,
      });
      await harness.installer.installUpload(preview.uploadId ?? "", true);
    }

    const result = await harness.installer.rollback("demo");
    expect(result.plugin).toMatchObject({ status: "loaded", version: "0.10.0" });
    expect(result.install).toMatchObject({ backups: 1 });
  });

  it("restores the pre-rollback version when a rollback reload fails", async () => {
    const harness = await makeHarness();
    const first = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo-1.zip",
    });
    await harness.installer.installUpload(first.uploadId ?? "", true);
    const second = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo-2.zip",
    });
    await harness.installer.installUpload(second.uploadId ?? "", true);
    harness.failReloadOnce.add("demo");

    const result = await harness.installer.rollback("demo");
    expect(result.plugin).toMatchObject({
      status: "loaded",
      version: "0.2.0",
      managed: true,
    });
    expect(result.reload.ok).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/simulated reload failure/i);
    expect(result.warnings.join("\n")).toMatch(/rollback failed/i);
    expect(result.warnings.join("\n")).toMatch(/restored the pre-rollback version/i);
    expect(result.install).toMatchObject({ managed: true, backups: 1 });

    const target = join(harness.pluginsDir, ".managed", "demo");
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      opencodeQq: { version: string };
    };
    expect(packageJson.opencodeQq.version).toBe("0.2.0");
    expect(harness.statuses.get("demo")).toMatchObject({ status: "loaded", version: "0.2.0" });

    const backups = await readdir(join(harness.pluginsDir, ".managed", ".backups", "demo"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/failed-0\.1\.0$/);
  });

  it("uninstalls managed code but keeps plugin data by default", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await harness.installer.installUpload(preview.uploadId ?? "", true);
    const dataDir = join(harness.pluginsDir, "demo");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "state.json"), "keep", "utf8");

    const result = await harness.installer.uninstall("demo", false);
    expect(result).toMatchObject({
      configRemoved: true,
      codeRemoved: true,
      dataDeleted: false,
    });
    expect(result.reload.ok).toBe(true);
    await expect(stat(join(harness.pluginsDir, ".managed", "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(dataDir, "state.json"), "utf8")).toBe("keep");
    expect((await readConfig(harness.configPath)).plugins.demo).toBeUndefined();
    expect(harness.statuses.has("demo")).toBe(false);
  });

  it("deletes plugin data when uninstalling with deleteData", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await harness.installer.installUpload(preview.uploadId ?? "", true);
    const dataDir = join(harness.pluginsDir, "demo");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "state.json"), "remove", "utf8");

    const result = await harness.installer.uninstall("demo", true);
    expect(result).toMatchObject({
      configRemoved: true,
      codeRemoved: true,
      dataDeleted: true,
    });
    await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inherited plugin ids without touching plugin data", async () => {
    const harness = await makeHarness();
    const inherited = join(harness.pluginsDir, "constructor");
    await mkdir(inherited, { recursive: true });
    await writeFile(join(inherited, "state.json"), "keep", "utf8");
    const proto = join(harness.pluginsDir, "__proto__");
    await mkdir(proto, { recursive: true });
    await writeFile(join(proto, "state.json"), "keep", "utf8");

    await expectInstallError(
      harness.installer.uninstall("constructor", true),
      "plugin_not_found",
      404,
    );
    await expectInstallError(
      harness.installer.uninstall("__proto__", true),
      "plugin_not_found",
      404,
    );
    await expectInstallError(harness.installer.reload("constructor"), "plugin_not_found", 404);

    expect(await readFile(join(inherited, "state.json"), "utf8")).toBe("keep");
    expect(await readFile(join(proto, "state.json"), "utf8")).toBe("keep");
  });

  it("removes managed backups on uninstall so a reinstall cannot roll back to removed code", async () => {
    const harness = await makeHarness();
    const first = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo-1.zip",
    });
    await harness.installer.installUpload(first.uploadId ?? "", true);
    const second = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo-2.zip",
    });
    await harness.installer.installUpload(second.uploadId ?? "", true);
    const backupRoot = join(harness.pluginsDir, ".managed", ".backups", "demo");
    expect(await readdir(backupRoot)).toHaveLength(1);

    const result = await harness.installer.uninstall("demo", false);
    expect(result).toMatchObject({ configRemoved: true, codeRemoved: true });
    await expect(stat(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const third = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.3.0"),
      filename: "demo-3.zip",
    });
    const reinstalled = await harness.installer.installUpload(third.uploadId ?? "", true);
    expect(reinstalled.plugin.managed).toBe(true);
    expect(reinstalled.install).toMatchObject({ backups: 0 });
    await expectInstallError(harness.installer.rollback("demo"), "no_backup", 409);
  });

  it("treats an already-missing managed code directory as removed and deletes backups", async () => {
    const harness = await makeHarness();
    const first = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo-1.zip",
    });
    await harness.installer.installUpload(first.uploadId ?? "", true);
    const second = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.2.0"),
      filename: "demo-2.zip",
    });
    await harness.installer.installUpload(second.uploadId ?? "", true);
    const backupRoot = join(harness.pluginsDir, ".managed", ".backups", "demo");
    expect(await readdir(backupRoot)).toHaveLength(1);

    const target = join(harness.pluginsDir, ".managed", "demo");
    const mutate = harness.editor.mutate.bind(harness.editor);
    harness.editor.mutate = async (mutator, expectedHash) => {
      const result = await mutate(mutator, expectedHash);
      await rm(target, { recursive: true, force: true });
      return result;
    };

    const result = await harness.installer.uninstall("demo", false);
    expect(result).toMatchObject({ configRemoved: true, codeRemoved: true });
    await expect(stat(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps recent trash for recovery and only prunes stale trash", async () => {
    const harness = await makeHarness();
    const trashRoot = join(harness.pluginsDir, ".managed", ".trash");
    const recent = join(trashRoot, "recent");
    const stale = join(trashRoot, "stale");
    await mkdir(recent, { recursive: true });
    await mkdir(stale, { recursive: true });
    await writeFile(join(recent, "code.js"), "recent", "utf8");
    await writeFile(join(stale, "code.js"), "stale", "utf8");
    await utimes(stale, new Date(0), new Date(0));

    await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });

    expect((await stat(recent)).isDirectory()).toBe(true);
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to delete plugin data through a symlink escape", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await harness.installer.installUpload(preview.uploadId ?? "", true);

    const outside = join(harness.root, "outside-data");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, join(harness.pluginsDir, "demo"));

    const result = await harness.installer.uninstall("demo", true);
    expect(result.dataDeleted).toBe(false);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside");
    expect(result.warnings.join("\n")).toMatch(/outside the plugin data directory/i);
  });

  it("rejects installs when the plugin host has not started", async () => {
    const harness = await makeHarness({ started: false });
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await expectInstallError(
      harness.installer.installUpload(preview.uploadId ?? "", true),
      "install_failed",
      503,
    );
    await expect(stat(join(harness.pluginsDir, ".managed", "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readConfig(harness.configPath)).plugins.demo).toBeUndefined();
  });

  it("rejects local packages inside the plugin data directory", async () => {
    const harness = await makeHarness();
    const local = await writePluginPackage(harness.pluginsDir, "demo", "0.1.0");

    await expectInstallError(harness.installer.installLocal(local, true), "package_conflict", 409);
    expect((await readConfig(harness.configPath)).plugins.demo).toBeUndefined();
  });

  it("returns plugin_not_found when reloading an unknown plugin", async () => {
    const harness = await makeHarness();
    await expectInstallError(harness.installer.reload("missing"), "plugin_not_found", 404);
    expect(harness.reloads).toEqual([]);
  });

  it("rejects unknown, traversal and expired upload ids", async () => {
    let clock = 1_700_000_000_000;
    const harness = await makeHarness({ now: () => clock });
    await expectInstallError(
      harness.installer.installUpload("00000000-0000-4000-8000-000000000000", true),
      "upload_not_found",
      404,
    );
    await expectInstallError(
      harness.installer.installUpload("../../outside", true),
      "upload_not_found",
      404,
    );

    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    clock += PLUGIN_ARCHIVE_LIMITS.stagingTtlMs + 1;
    await expectInstallError(
      harness.installer.installUpload(preview.uploadId ?? "", true),
      "upload_expired",
      410,
    );
  });

  it("installs a local package without copying code and reloads a changed-path-free reinstall", async () => {
    const harness = await makeHarness();
    const local = await writePluginPackage(join(harness.root, "local"), "demo", "0.3.0");

    const preview = await harness.installer.previewLocal(local);
    expect(preview).toMatchObject({ uploadId: null, archive: null, entry: "index.js" });
    expect(preview.existing).toBeNull();

    const result = await harness.installer.installLocal(local, true);
    expect(result.plugin).toMatchObject({ status: "loaded", version: "0.3.0", managed: false });
    expect(result.install).toMatchObject({
      managed: false,
      sourceKind: "path",
      archiveName: null,
      archiveSha256: null,
      previousVersion: null,
      backups: 0,
    });
    const config = await readConfig(harness.configPath);
    expect(config.plugins.demo).toMatchObject({ enabled: true, path: local });
    await expect(stat(join(harness.pluginsDir, ".managed", "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(join(local, "index.js"))).isFile()).toBe(true);

    harness.reloads.length = 0;
    await harness.installer.installLocal(local, true);
    expect(harness.reloads).toEqual(["demo"]);
  });

  it("rejects installing a local package from inside the managed directory", async () => {
    const harness = await makeHarness();
    const preview = await harness.installer.previewUpload({
      buffer: await pluginZip("demo", "0.1.0"),
      filename: "demo.zip",
    });
    await harness.installer.installUpload(preview.uploadId ?? "", true);

    await expectInstallError(
      harness.installer.installLocal(join(harness.pluginsDir, ".managed", "demo"), true),
      "package_conflict",
      409,
    );
  });
});
