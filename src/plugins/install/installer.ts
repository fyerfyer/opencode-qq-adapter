import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AdminConfigError, type ConfigEditor } from "../../admin/config-editor.js";
import type { ConfigReloadResult } from "../../config/reload.js";
import type { AppConfig, PluginConfig } from "../../config/schema.js";
import { isPathInside } from "../../util/path.js";
import type { PluginHost, PluginStatus } from "../host.js";
import { PLUGIN_API_VERSION } from "../sdk.js";
import { extractZip } from "./archive.js";
import { inspectPackage, type PackageInspection } from "./package.js";
import {
  type InstalledPluginStatus,
  PLUGIN_ARCHIVE_LIMITS,
  type PluginActionResult,
  PluginInstallError,
  type PluginInstallInfo,
  type PluginPackagePreview,
  type PluginUninstallResult,
} from "./types.js";

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_FILE = "meta.json";
const INSTALL_META_FILE = ".opencode-qq-install.json";
const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

interface PluginInstallerLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface PluginInstallerOptions {
  config: AppConfig;
  configPath: string | null;
  configEditor: Pick<ConfigEditor, "enabled" | "read" | "mutate">;
  host: Pick<PluginHost, "status" | "reloadPlugin" | "started">;
  coreVersion: string;
  logger: PluginInstallerLogger;
  now?: () => number;
}

interface StagingMeta {
  filename: string;
  bytes: number;
  sha256: string;
  uploadedAt: number;
  packageRoot: string;
}

interface InstallMetadata {
  source: string;
  archiveName: string | null;
  archiveSha256: string | null;
  installedAt: number;
  installedBy: string;
}

/**
 * Installs, updates and removes plugins that are managed under
 * `<plugins_dir>/.managed/<id>` while keeping plugin data untouched.
 *
 * All mutating operations are serialized so two concurrent admin requests
 * cannot swap the same plugin directory or YAML entry at the same time.
 */
export class PluginInstaller {
  readonly #config: AppConfig;
  readonly #configPath: string | null;
  readonly #configEditor: PluginInstallerOptions["configEditor"];
  readonly #host: PluginInstallerOptions["host"];
  readonly #coreVersion: string;
  readonly #logger: PluginInstallerLogger;
  readonly #now: () => number;
  readonly #pluginsDir: string;
  readonly #managedRoot: string;
  readonly #stagingRoot: string;
  readonly #backupsRoot: string;
  readonly #trashRoot: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PluginInstallerOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#configEditor = options.configEditor;
    this.#host = options.host;
    this.#coreVersion = options.coreVersion;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#pluginsDir = resolve(options.config.storage.plugins_dir);
    this.#managedRoot = join(this.#pluginsDir, ".managed");
    this.#stagingRoot = join(this.#managedRoot, ".staging");
    this.#backupsRoot = join(this.#managedRoot, ".backups");
    this.#trashRoot = join(this.#managedRoot, ".trash");
  }

  async previewUpload(input: { buffer: Buffer; filename: string }): Promise<PluginPackagePreview> {
    return this.#enqueue(() => this.#guard(() => this.#previewUpload(input)));
  }

  async installUpload(
    uploadId: string,
    enable: boolean,
    expectedHash?: string,
  ): Promise<PluginActionResult> {
    return this.#enqueue(() =>
      this.#guard(() => this.#installUpload(uploadId, enable, expectedHash)),
    );
  }

  async previewLocal(path: string): Promise<PluginPackagePreview> {
    return this.#guard(() => this.#previewLocal(path));
  }

  async installLocal(
    path: string,
    enable: boolean,
    expectedHash?: string,
  ): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#guard(() => this.#installLocal(path, enable, expectedHash)));
  }

  async uninstall(
    id: string,
    deleteData: boolean,
    expectedHash?: string,
  ): Promise<PluginUninstallResult> {
    return this.#enqueue(() => this.#guard(() => this.#uninstall(id, deleteData, expectedHash)));
  }

  async rollback(id: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#guard(() => this.#rollback(id)));
  }

  async reload(id: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#guard(() => this.#reload(id)));
  }

  isManaged(id: string): boolean {
    if (!PLUGIN_ID_PATTERN.test(id)) return false;
    const entry = this.#pluginConfig(id);
    if (entry === undefined || entry.path === undefined) return false;
    return resolve(this.#resolveConfigPath(entry.path)) === this.managedPath(id);
  }

  managedPath(id: string): string {
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new PluginInstallError(400, "package_invalid", `Invalid plugin id: ${id}`);
    }
    return join(this.#managedRoot, id);
  }

  async #previewUpload(input: { buffer: Buffer; filename: string }): Promise<PluginPackagePreview> {
    await this.#cleanupStale();
    if (input.buffer.byteLength > PLUGIN_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new PluginInstallError(
        413,
        "archive_too_large",
        `ZIP is larger than ${PLUGIN_ARCHIVE_LIMITS.maxArchiveBytes} bytes`,
      );
    }
    const uploadId = randomUUID();
    const staging = join(this.#stagingRoot, uploadId);
    const packageDir = join(staging, "package");
    const sha256 = createHash("sha256").update(input.buffer).digest("hex");

    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const extracted = await extractZip(input.buffer, packageDir);
      const inspection = await inspectPackage(extracted.root, {
        coreVersion: this.#coreVersion,
        source: "upload",
        files: extracted.files,
        bytes: extracted.bytes,
      });
      const meta: StagingMeta = {
        filename: input.filename,
        bytes: input.buffer.byteLength,
        sha256,
        uploadedAt: this.#now(),
        packageRoot: relative(staging, extracted.root).split(sep).join("/"),
      };
      await writeFile(join(staging, META_FILE), JSON.stringify(meta), {
        encoding: "utf8",
        mode: 0o600,
      });
      const snapshot = await this.#configSnapshot();
      return this.#preview(
        uploadId,
        { name: input.filename, bytes: input.buffer.byteLength, sha256 },
        inspection,
        await this.#existing(inspection.manifest.id),
        snapshot,
      );
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #installUpload(
    uploadId: string,
    enable: boolean,
    expectedHash?: string,
  ): Promise<PluginActionResult> {
    this.#assertHostStarted();
    this.#assertConfigEnabled();
    if (!UPLOAD_ID_PATTERN.test(uploadId)) {
      throw new PluginInstallError(404, "upload_not_found", "Uploaded package was not found.");
    }

    const staging = join(this.#stagingRoot, uploadId);
    const meta = await this.#readStagingMeta(staging);
    if (this.#now() - meta.uploadedAt > PLUGIN_ARCHIVE_LIMITS.stagingTtlMs) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw new PluginInstallError(
        410,
        "upload_expired",
        "Uploaded package has expired; upload it again.",
      );
    }

    try {
      const packageRoot = this.#packageRoot(staging, meta);
      const inspection = await inspectPackage(packageRoot, {
        coreVersion: this.#coreVersion,
        source: "upload",
      });
      const id = inspection.manifest.id;
      const target = this.managedPath(id);
      const configured = this.#pluginConfig(id);
      if (configured !== undefined) {
        const configuredPath =
          configured.path === undefined ? null : this.#resolveConfigPath(configured.path);
        if (configuredPath === null || resolve(configuredPath) !== target) {
          throw new PluginInstallError(
            409,
            "package_conflict",
            `Plugin ${id} is already configured from a different path.`,
          );
        }
      }

      const existing = await this.#existing(id);
      const previousVersion =
        existing?.version !== undefined && existing.version !== "-"
          ? existing.version
          : await this.#versionAt(target);
      const wasManaged = existing?.managed === true;
      const backup =
        (await pathExists(target)) === true
          ? await this.#createBackup(id, previousVersion ?? "unknown")
          : null;

      try {
        await mkdir(this.#managedRoot, { recursive: true, mode: 0o700 });
        await rename(packageRoot, target);
      } catch (error) {
        await this.#restoreBackup(target, backup);
        throw error;
      }

      let saved: Awaited<ReturnType<PluginInstallerOptions["configEditor"]["mutate"]>>;
      try {
        saved = await this.#writeManagedEntry(id, target, enable, expectedHash);
      } catch (error) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        await this.#restoreBackup(target, backup);
        throw error;
      }

      const warnings = new Set([
        ...inspection.warnings,
        ...saved.warnings,
        ...saved.reload.warnings,
        ...(saved.reload.error === undefined ? [] : [saved.reload.error]),
      ]);
      let reload = saved.reload;
      if (wasManaged) {
        try {
          await this.#host.reloadPlugin(id);
        } catch (error) {
          const message = errorMessage(error);
          warnings.add(`Plugin reload failed: ${message}`);
          reload = { ...reload, ok: false, error: message };
        }
      }

      const plugin = this.#findStatus(id);
      if (plugin === undefined) {
        throw new PluginInstallError(
          500,
          "install_failed",
          `Plugin ${id} was installed but did not appear in the plugin host.`,
        );
      }
      if (plugin.status === "failed" && plugin.error !== null) {
        warnings.add(plugin.error);
      }

      try {
        await this.#writeInstallMetadata(target, {
          source: "upload",
          archiveName: meta.filename,
          archiveSha256: meta.sha256,
          installedAt: this.#now(),
          installedBy: "admin",
        });
      } catch (error) {
        warnings.add("Install metadata could not be written; rollback details may be limited.");
        this.#logger.warn(
          { err: error, pluginId: id },
          "Failed to write managed plugin install metadata",
        );
      }

      const install = await this.#installInfo(id, previousVersion ?? null);
      this.#logger.info(
        { pluginId: id, version: inspection.manifest.version, managed: true },
        "Plugin installed from upload",
      );
      return {
        plugin: { ...plugin, managed: this.isManaged(id) },
        install,
        reload,
        warnings: [...warnings],
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #previewLocal(path: string): Promise<PluginPackagePreview> {
    const source = await this.#resolveLocalDirectory(path);
    const inspection = await inspectPackage(source, {
      coreVersion: this.#coreVersion,
      source: "local",
    });
    const snapshot = await this.#configSnapshot();
    return this.#preview(
      null,
      null,
      inspection,
      await this.#existing(inspection.manifest.id),
      snapshot,
    );
  }

  async #installLocal(
    path: string,
    enable: boolean,
    expectedHash?: string,
  ): Promise<PluginActionResult> {
    this.#assertHostStarted();
    this.#assertConfigEnabled();
    const source = await this.#resolveLocalDirectory(path);
    await this.#assertLocalPathAllowed(source);
    const inspection = await inspectPackage(source, {
      coreVersion: this.#coreVersion,
      source: "local",
    });
    const id = inspection.manifest.id;
    const configured = this.#pluginConfig(id);

    let samePath = false;
    if (configured !== undefined) {
      const configuredPath =
        configured.path === undefined ? null : this.#resolveConfigPath(configured.path);
      if (configuredPath === null || !(await pathsMatch(configuredPath, source))) {
        throw new PluginInstallError(
          409,
          "package_conflict",
          `Plugin ${id} is already configured from a different ${configured.package === undefined ? "path" : "package"}.`,
        );
      }
      samePath = true;
    }

    const existing = await this.#existing(id);
    const previousVersion =
      existing?.version !== undefined && existing.version !== "-" ? existing.version : null;
    const saved = await this.#writeManagedEntry(id, source, enable, expectedHash);
    const warnings = new Set([
      ...inspection.warnings,
      ...saved.warnings,
      ...saved.reload.warnings,
      ...(saved.reload.error === undefined ? [] : [saved.reload.error]),
    ]);
    let reload = saved.reload;

    if (samePath && enable) {
      try {
        await this.#host.reloadPlugin(id);
      } catch (error) {
        const message = errorMessage(error);
        warnings.add(`Plugin reload failed: ${message}`);
        reload = { ...reload, ok: false, error: message };
      }
    }

    const plugin = this.#findStatus(id);
    if (plugin === undefined) {
      throw new PluginInstallError(
        500,
        "install_failed",
        `Plugin ${id} was configured but did not appear in the plugin host.`,
      );
    }
    if (plugin.status === "failed" && plugin.error !== null) {
      warnings.add(plugin.error);
    }

    const install = await this.#installInfo(id, previousVersion);
    this.#logger.info(
      { pluginId: id, version: inspection.manifest.version, managed: false },
      "Local plugin configured",
    );
    return {
      plugin: { ...plugin, managed: this.isManaged(id) },
      install,
      reload,
      warnings: [...warnings],
    };
  }

  async #uninstall(
    id: string,
    deleteData: boolean,
    expectedHash?: string,
  ): Promise<PluginUninstallResult> {
    this.#assertHostStarted();
    this.#assertConfigEnabled();
    if (!PLUGIN_ID_PATTERN.test(id) || this.#pluginConfig(id) === undefined) {
      throw new PluginInstallError(404, "plugin_not_found", `Plugin ${id} is not configured.`);
    }

    const managed = this.isManaged(id);
    const saved = await this.#deleteConfigEntry(id, expectedHash);
    const warnings = new Set([
      ...saved.warnings,
      ...saved.reload.warnings,
      ...(saved.reload.error === undefined ? [] : [saved.reload.error]),
    ]);
    const configRemoved = true;

    if (!saved.reload.ok) {
      warnings.add("Configuration reload failed; code and data were kept for a retry.");
      return {
        configRemoved,
        codeRemoved: false,
        dataDeleted: false,
        reload: saved.reload,
        warnings: [...warnings],
      };
    }

    let codeRemoved = false;
    if (managed) {
      const target = this.managedPath(id);
      try {
        await rm(target, { recursive: true, force: true });
        codeRemoved = true;
      } catch (error) {
        warnings.add(`Managed plugin code could not be removed: ${errorMessage(error)}`);
      }
      if (codeRemoved) {
        try {
          await rm(join(this.#backupsRoot, id), { recursive: true, force: true });
        } catch (error) {
          warnings.add(`Managed plugin backups could not be removed: ${errorMessage(error)}`);
        }
      }
    }

    let dataDeleted = false;
    if (deleteData) {
      dataDeleted = await this.#deleteData(id, warnings);
    }

    this.#logger.info({ pluginId: id, managed, deleteData }, "Plugin uninstalled");
    return {
      configRemoved,
      codeRemoved,
      dataDeleted,
      reload: saved.reload,
      warnings: [...warnings],
    };
  }

  async #rollback(id: string): Promise<PluginActionResult> {
    this.#assertHostStarted();
    if (!this.isManaged(id)) {
      throw new PluginInstallError(
        409,
        "package_conflict",
        `Plugin ${id} is not installed from a managed package.`,
      );
    }
    const target = this.managedPath(id);
    const backups = await this.#listBackups(id);
    const newest = backups[0];
    if (newest === undefined) {
      throw new PluginInstallError(409, "no_backup", `Plugin ${id} has no backup to roll back to.`);
    }

    const warnings = new Set<string>();
    const trash = join(this.#trashRoot, randomUUID());
    await mkdir(this.#trashRoot, { recursive: true, mode: 0o700 });
    const currentExists = (await pathExists(target)) === true;
    const previousVersion = currentExists ? await this.#versionAt(target) : null;
    if (currentExists) {
      await rename(target, trash);
    }
    try {
      await rename(newest.path, target);
    } catch (error) {
      if (currentExists) {
        await rename(trash, target).catch(() => undefined);
      }
      throw new PluginInstallError(
        500,
        "install_failed",
        `Failed to restore the backup for plugin ${id}: ${errorMessage(error)}`,
      );
    }

    let reloadError: string | null = null;
    try {
      const status = await this.#host.reloadPlugin(id);
      if (status === "failed") reloadError = `Plugin ${id} failed to load after rollback.`;
    } catch (error) {
      reloadError = errorMessage(error);
    }
    if (reloadError !== null) {
      return this.#recoverFailedRollback(id, {
        target,
        trash,
        currentExists,
        previousVersion,
        reloadError,
        warnings,
      });
    }

    await rm(trash, { recursive: true, force: true }).catch(() => undefined);

    const found = this.#findStatus(id);
    if (found === undefined) {
      const version = (await this.#versionAt(target)) ?? null;
      const error = `Plugin ${id} did not appear in the plugin host after rollback.`;
      warnings.add(error);
      return {
        plugin: this.#failedStatus(id, error, version),
        install: await this.#installInfo(id, null),
        reload: {
          ok: false,
          applied: [],
          restartRequired: [],
          warnings: [...warnings],
          error,
        },
        warnings: [...warnings],
      };
    }

    const plugin: InstalledPluginStatus = { ...found, managed: this.isManaged(id) };
    if (plugin.status === "failed" && plugin.error !== null) {
      warnings.add(plugin.error);
    }
    const reload: ConfigReloadResult = {
      ok: plugin.status !== "failed",
      applied: [],
      restartRequired: [],
      warnings: [...warnings],
    };

    const install = await this.#installInfo(id, null);
    this.#logger.info(
      { pluginId: id, backup: newest.name, status: plugin.status },
      "Plugin rolled back",
    );
    return { plugin, install, reload, warnings: [...warnings] };
  }

  /**
   * A rollback reload failed: preserve the restored (broken) version in
   * backups, bring the pre-rollback version back, and report a degraded result.
   * The trash copy is only removed when the rollback actually succeeded.
   */
  async #recoverFailedRollback(
    id: string,
    input: {
      target: string;
      trash: string;
      currentExists: boolean;
      previousVersion: string | null;
      reloadError: string;
      warnings: Set<string>;
    },
  ): Promise<PluginActionResult> {
    input.warnings.add(`Rollback failed: ${input.reloadError}`);
    const failedVersion = (await this.#versionAt(input.target)) ?? "unknown";
    let quarantined = false;
    try {
      await this.#createBackup(id, `failed-${failedVersion}`);
      quarantined = true;
    } catch (error) {
      input.warnings.add(
        `The failed plugin version could not be moved to backups: ${errorMessage(error)}`,
      );
    }

    const targetExists = (await pathExists(input.target)) === true;
    let restored = false;
    let restoredLoaded = false;
    if (input.currentExists && !targetExists) {
      try {
        await rename(input.trash, input.target);
        restored = true;
      } catch (error) {
        input.warnings.add(
          `The previous plugin version could not be restored; its files remain at ${input.trash}: ${errorMessage(error)}`,
        );
      }
    } else if (input.currentExists) {
      input.warnings.add(
        `The previous plugin version could not be restored automatically; its files remain at ${input.trash}.`,
      );
    }

    if (restored) {
      try {
        const status = await this.#host.reloadPlugin(id);
        restoredLoaded = status === "loaded";
        if (status === "failed") {
          input.warnings.add(
            "The previous plugin version was restored on disk but failed to load.",
          );
        }
      } catch (error) {
        input.warnings.add(
          `The previous plugin version was restored on disk but its reload failed: ${errorMessage(error)}`,
        );
      }
      input.warnings.add(
        `Restored the pre-rollback version${input.previousVersion === null ? "" : ` (${input.previousVersion})`} after the failed rollback.`,
      );
    } else if (!input.currentExists) {
      input.warnings.add(
        "There was no pre-rollback version on disk, so the failed rollback could not be undone.",
      );
    }

    const version = restored
      ? (input.previousVersion ?? (await this.#versionAt(input.target)))
      : ((await this.#versionAt(input.target)) ?? input.previousVersion);
    const current = restoredLoaded ? this.#findStatus(id) : undefined;
    const plugin: InstalledPluginStatus =
      current === undefined
        ? this.#failedStatus(id, `Rollback failed: ${input.reloadError}`, version)
        : { ...current, managed: this.isManaged(id) };
    this.#logger.warn(
      { pluginId: id, reloadError: input.reloadError, quarantined, restored },
      "Plugin rollback failed; previous version restoration attempted",
    );
    return {
      plugin,
      install: await this.#installInfo(id, null),
      reload: {
        ok: false,
        applied: [],
        restartRequired: [],
        warnings: [...input.warnings],
        error: input.reloadError,
      },
      warnings: [...input.warnings],
    };
  }

  async #reload(id: string): Promise<PluginActionResult> {
    this.#assertHostStarted();
    if (!PLUGIN_ID_PATTERN.test(id) || this.#pluginConfig(id) === undefined) {
      throw new PluginInstallError(404, "plugin_not_found", `Plugin ${id} is not configured.`);
    }
    try {
      await this.#host.reloadPlugin(id);
    } catch (error) {
      throw new PluginInstallError(
        500,
        "install_failed",
        `Failed to reload plugin ${id}: ${errorMessage(error)}`,
      );
    }
    const found = this.#findStatus(id);
    if (found === undefined) {
      throw new PluginInstallError(
        500,
        "install_failed",
        `Plugin ${id} did not appear in the plugin host after reloading.`,
      );
    }
    const plugin: InstalledPluginStatus = { ...found, managed: this.isManaged(id) };
    const warnings = plugin.error === null ? [] : [plugin.error];
    return {
      plugin,
      install: await this.#installInfo(id, null),
      reload: {
        ok: plugin.status !== "failed",
        applied: [],
        restartRequired: [],
        warnings,
      },
      warnings,
    };
  }

  #preview(
    uploadId: string | null,
    archive: PluginPackagePreview["archive"],
    inspection: PackageInspection,
    existing: PluginPackagePreview["existing"],
    snapshot: { hash: string | null; path: string | null },
  ): PluginPackagePreview {
    const manifest = inspection.manifest;
    return {
      uploadId,
      archive,
      manifest: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        description: manifest.description ?? null,
        capabilities: [...(manifest.capabilities ?? [])],
        engines: { opencodeQq: manifest.engines?.opencodeQq ?? null },
        ui: inspection.ui,
      },
      entry: inspection.entry,
      packageName: inspection.packageName,
      files: inspection.files,
      bytes: inspection.bytes,
      warnings: [...inspection.warnings],
      existing,
      configHash: snapshot.hash,
      configPath: snapshot.path,
    };
  }

  async #existing(id: string): Promise<PluginPackagePreview["existing"]> {
    const entry = this.#pluginConfig(id);
    if (entry === undefined) return null;
    const status = this.#findStatus(id);
    const statusVersion = status?.version;
    const version =
      statusVersion !== undefined && statusVersion !== "-"
        ? statusVersion
        : await this.#packageVersion(entry);
    return {
      id,
      version: version ?? "-",
      status: status?.status ?? "disabled",
      managed: this.isManaged(id),
      sourceKind: entry.package === undefined ? "path" : "package",
    };
  }

  async #installInfo(id: string, previousVersion: string | null): Promise<PluginInstallInfo> {
    const managed = this.isManaged(id);
    const metadata = managed ? await this.#readInstallMetadata(id) : null;
    const backups = managed ? await this.#listBackups(id) : [];
    const entry = this.#pluginConfig(id);
    return {
      managed,
      sourceKind: entry?.package === undefined ? "path" : "package",
      archiveName: metadata?.archiveName ?? null,
      archiveSha256: metadata?.archiveSha256 ?? null,
      installedAt: metadata?.installedAt ?? null,
      previousVersion,
      backups: backups.length,
    };
  }

  async #configSnapshot(): Promise<{ hash: string | null; path: string | null }> {
    if (!this.#configEditor.enabled) {
      return { hash: null, path: this.#configPath };
    }
    try {
      const snapshot = await this.#configEditor.read();
      return { hash: snapshot.hash, path: snapshot.path };
    } catch (error) {
      this.#logger.warn({ err: error }, "Unable to read config while previewing a plugin");
      return { hash: null, path: this.#configPath };
    }
  }

  async #writeManagedEntry(id: string, path: string, enable: boolean, expectedHash?: string) {
    return this.#configEditor.mutate((document) => {
      if (document.get("plugins") === null || document.get("plugins") === undefined) {
        document.set("plugins", document.createNode({}));
      }
      document.setIn(["plugins", id, "path"], path);
      document.setIn(["plugins", id, "enabled"], enable);
      document.deleteIn(["plugins", id, "package"]);
    }, expectedHash);
  }

  async #deleteConfigEntry(id: string, expectedHash?: string) {
    return this.#configEditor.mutate((document) => {
      document.deleteIn(["plugins", id]);
    }, expectedHash);
  }

  async #readStagingMeta(staging: string): Promise<StagingMeta> {
    const meta = await this.#tryReadStagingMeta(staging);
    if (meta === null) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw new PluginInstallError(404, "upload_not_found", "Uploaded package was not found.");
    }
    return meta;
  }

  async #tryReadStagingMeta(staging: string): Promise<StagingMeta | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(staging, META_FILE), "utf8"));
    } catch {
      return null;
    }
    if (!isRecord(raw)) return null;
    if (
      typeof raw.filename !== "string" ||
      typeof raw.bytes !== "number" ||
      !Number.isFinite(raw.bytes) ||
      typeof raw.sha256 !== "string" ||
      typeof raw.uploadedAt !== "number" ||
      !Number.isFinite(raw.uploadedAt) ||
      typeof raw.packageRoot !== "string"
    ) {
      return null;
    }
    return {
      filename: raw.filename,
      bytes: raw.bytes,
      sha256: raw.sha256,
      uploadedAt: raw.uploadedAt,
      packageRoot: raw.packageRoot,
    };
  }

  #packageRoot(staging: string, meta: StagingMeta): string {
    const root = resolve(staging, meta.packageRoot);
    if (!isPathInside(staging, root, { allowRoot: false })) {
      throw new PluginInstallError(
        400,
        "package_invalid",
        "Uploaded package root escapes its staging directory.",
      );
    }
    return root;
  }

  async #cleanupStale(): Promise<void> {
    const now = this.#now();
    let stagingEntries: Dirent[];
    try {
      stagingEntries = await readdir(this.#stagingRoot, { withFileTypes: true });
    } catch {
      stagingEntries = [];
    }
    for (const entry of stagingEntries) {
      const path = join(this.#stagingRoot, entry.name);
      if (!entry.isDirectory()) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      const meta = await this.#tryReadStagingMeta(path);
      if (meta === null || now - meta.uploadedAt > PLUGIN_ARCHIVE_LIMITS.stagingTtlMs) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    let trashEntries: Dirent[];
    try {
      trashEntries = await readdir(this.#trashRoot, { withFileTypes: true });
    } catch {
      trashEntries = [];
    }
    for (const entry of trashEntries) {
      const path = join(this.#trashRoot, entry.name);
      const info = await stat(path).catch(() => null);
      if (info === null || now - info.mtimeMs > TRASH_TTL_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #createBackup(id: string, version: string): Promise<string> {
    const backupRoot = join(this.#backupsRoot, id);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const existing = await this.#listBackups(id);
    const newest = existing[0];
    const timestamp = Math.max(
      this.#now(),
      newest === undefined ? 0 : backupTimestamp(newest.name) + 1,
    );
    const base = `${timestamp}-${sanitizeBackupPart(version)}`;
    let candidate = join(backupRoot, base);
    let suffix = 2;
    while ((await pathExists(candidate)) === true) {
      candidate = join(backupRoot, `${base}-${suffix}`);
      suffix += 1;
    }
    await rename(this.managedPath(id), candidate);
    await this.#pruneBackups(id);
    return candidate;
  }

  async #restoreBackup(target: string, backup: string | null): Promise<void> {
    if (backup === null) return;
    await rename(backup, target).catch((error) => {
      this.#logger.error(
        { err: error, pluginId: target.split(sep).at(-1) ?? null },
        "Failed to restore the previous managed plugin",
      );
    });
  }

  async #pruneBackups(id: string): Promise<void> {
    const backups = await this.#listBackups(id);
    for (const backup of backups.slice(PLUGIN_ARCHIVE_LIMITS.maxBackups)) {
      await rm(backup.path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #listBackups(id: string): Promise<Array<{ name: string; path: string }>> {
    const root = join(this.#backupsRoot, id);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
      .sort(
        (left, right) =>
          backupTimestamp(right.name) - backupTimestamp(left.name) ||
          right.name.localeCompare(left.name),
      );
  }

  async #writeInstallMetadata(target: string, metadata: InstallMetadata): Promise<void> {
    await writeFile(join(target, INSTALL_META_FILE), JSON.stringify(metadata), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async #readInstallMetadata(id: string): Promise<InstallMetadata | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.managedPath(id), INSTALL_META_FILE), "utf8"));
    } catch {
      return null;
    }
    if (!isRecord(raw)) return null;
    if (
      typeof raw.source !== "string" ||
      typeof raw.installedAt !== "number" ||
      !Number.isFinite(raw.installedAt) ||
      typeof raw.installedBy !== "string" ||
      (raw.archiveName !== null && typeof raw.archiveName !== "string") ||
      (raw.archiveSha256 !== null && typeof raw.archiveSha256 !== "string")
    ) {
      return null;
    }
    return {
      source: raw.source,
      archiveName: typeof raw.archiveName === "string" ? raw.archiveName : null,
      archiveSha256: typeof raw.archiveSha256 === "string" ? raw.archiveSha256 : null,
      installedAt: raw.installedAt,
      installedBy: raw.installedBy,
    };
  }

  async #deleteData(id: string, warnings: Set<string>): Promise<boolean> {
    if (!PLUGIN_ID_PATTERN.test(id)) {
      warnings.add("Refusing to delete plugin data for an invalid plugin id.");
      return false;
    }
    const dataPath = join(this.#pluginsDir, id);
    if (!isPathInside(this.#pluginsDir, dataPath, { allowRoot: false })) {
      warnings.add("Refusing to delete plugin data outside the plugin directory.");
      return false;
    }
    const real = await realpath(dataPath).catch(() => null);
    if (real === null) return true;
    const realRoot = await realpath(this.#pluginsDir).catch(() => this.#pluginsDir);
    const rel = relative(realRoot, real);
    if (
      rel.length === 0 ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      rel === ".managed" ||
      rel.startsWith(`.managed${sep}`)
    ) {
      warnings.add("Refusing to delete plugin data outside the plugin data directory.");
      return false;
    }
    try {
      await rm(dataPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      warnings.add(`Plugin data could not be deleted: ${errorMessage(error)}`);
      return false;
    }
  }

  async #resolveLocalDirectory(path: string): Promise<string> {
    const absolute = this.#resolveInputPath(path);
    const real = await realpath(absolute).catch(() => null);
    if (real === null) {
      throw new PluginInstallError(400, "package_invalid", "Local plugin path does not exist.");
    }
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new PluginInstallError(
        400,
        "package_invalid",
        "Local plugin path must be a directory.",
      );
    }
    return real;
  }

  async #assertLocalPathAllowed(path: string): Promise<void> {
    const [realManaged, realPlugins] = await Promise.all([
      realpath(this.#managedRoot).catch(() => null),
      realpath(this.#pluginsDir).catch(() => null),
    ]);
    if (
      isPathInside(this.#managedRoot, path) ||
      (realManaged !== null && isPathInside(realManaged, path)) ||
      isPathInside(this.#pluginsDir, path) ||
      (realPlugins !== null && isPathInside(realPlugins, path))
    ) {
      throw new PluginInstallError(
        409,
        "package_conflict",
        "Local plugin path must not point inside the plugin directory or its managed/data subdirectories.",
      );
    }
  }

  async #packageVersion(entry: { path?: string; package?: string }): Promise<string | null> {
    if (entry.path === undefined) return null;
    return this.#versionAt(this.#resolveConfigPath(entry.path));
  }

  async #versionAt(path: string): Promise<string | null> {
    const info = await stat(path).catch(() => null);
    if (info === null) return null;
    const packageJsonPath = info.isFile()
      ? join(dirname(path), "package.json")
      : join(path, "package.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (!isRecord(parsed) || !isRecord(parsed.opencodeQq)) return null;
      const version = parsed.opencodeQq.version;
      return typeof version === "string" && version.length > 0 ? version : null;
    } catch {
      return null;
    }
  }

  #resolveInputPath(value: string): string {
    const expanded = expandHome(value.trim());
    if (isAbsolute(expanded)) return resolve(expanded);
    const base = this.#configPath === null ? process.cwd() : dirname(this.#configPath);
    return resolve(base, expanded);
  }

  #resolveConfigPath(value: string): string {
    return this.#resolveInputPath(value);
  }

  #pluginConfig(id: string): PluginConfig | undefined {
    if (!PLUGIN_ID_PATTERN.test(id) || !Object.hasOwn(this.#config.plugins, id)) {
      return undefined;
    }
    return this.#config.plugins[id];
  }

  #findStatus(id: string): PluginStatus | undefined {
    return this.#host.status().plugins.find((plugin) => plugin.id === id);
  }

  #failedStatus(id: string, error: string, version: string | null): InstalledPluginStatus {
    const entry = this.#pluginConfig(id);
    return {
      id,
      name: id,
      version: version ?? "-",
      apiVersion: PLUGIN_API_VERSION,
      description: null,
      status: "failed",
      error,
      capabilities: [],
      commands: [],
      source: entry?.path ?? entry?.package ?? this.managedPath(id),
      sourceKind: entry?.package === undefined ? "path" : "package",
      loadedAt: null,
      managed: true,
      admin: { routes: 0, pages: [] },
    };
  }

  #assertHostStarted(): void {
    if (!this.#host.started) {
      throw new PluginInstallError(503, "install_failed", "插件宿主尚未启动。");
    }
  }

  #assertConfigEnabled(): void {
    if (!this.#configEditor.enabled) {
      throw new PluginInstallError(
        409,
        "config_unavailable",
        "当前进程没有关联配置文件路径，无法安装插件。",
      );
    }
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #guard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw toInstallError(error);
    }
  }
}

function toInstallError(error: unknown): PluginInstallError {
  if (error instanceof PluginInstallError) return error;
  if (error instanceof AdminConfigError) {
    return new PluginInstallError(error.status, "install_failed", error.message, error.details);
  }
  const message = errorMessage(error);
  return new PluginInstallError(500, "install_failed", message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function pathsMatch(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  const [leftReal, rightReal] = await Promise.all([
    realpath(left).catch(() => null),
    realpath(right).catch(() => null),
  ]);
  return leftReal !== null && rightReal !== null && leftReal === rightReal;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function sanitizeBackupPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
  return sanitized.length === 0 ? "unknown" : sanitized;
}

function backupTimestamp(name: string): number {
  const prefix = name.split("-")[0] ?? "";
  const value = Number(prefix);
  return Number.isFinite(value) ? value : 0;
}
