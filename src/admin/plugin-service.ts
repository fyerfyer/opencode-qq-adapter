import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { AuditEntry } from "../domain/audit.js";
import type { AuditTrail } from "../observability/audit.js";
import type { PluginHost, PluginHostStatus, PluginStatus } from "../plugins/host.js";
import { PluginInstaller } from "../plugins/install/installer.js";
import {
  PLUGIN_ARCHIVE_LIMITS,
  type PluginActionResult,
  PluginInstallError,
  type PluginPackagePreview,
  type PluginUninstallResult,
} from "../plugins/install/types.js";
import type { PluginAdminActor, PluginAdminResult } from "../plugins/sdk.js";
import { PLUGIN_UI_PROTOCOL_VERSION } from "../plugins/ui-protocol.js";
import type { ConfigEditor, ConfigSaveResult } from "./config-editor.js";
import { AdminError } from "./errors.js";
import { PluginUiTokenSigner } from "./plugin-ui-token.js";

export interface AdminPluginStatus extends PluginStatus {
  managed: boolean;
}

export interface AdminPluginHostStatus extends Omit<PluginHostStatus, "plugins"> {
  plugins: AdminPluginStatus[];
}

export interface PluginOptionsSnapshot {
  plugin: AdminPluginStatus;
  options: Record<string, unknown>;
  normalized: unknown;
  error: string | null;
  configHash: string | null;
  configPath: string | null;
}

export interface PluginUiPageDescriptor {
  pluginId: string;
  pageId: string;
  title: string;
  description?: string;
  entry: string;
  protocol: typeof PLUGIN_UI_PROTOCOL_VERSION;
  url: string;
}

export interface PluginUiAssetPayload {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

export interface AdminPluginServiceOptions {
  config: AppConfig;
  configPath: string | null;
  version: string;
  configEditor: ConfigEditor;
  host: PluginHost | undefined;
  audit: AuditTrail;
  logger: Logger;
  now?: () => number;
}

const PLUGINS_DISABLED_MESSAGE = "插件宿主未启用。";

/**
 * Plugin management for the admin API.
 *
 * Keeps the runtime host, configuration YAML, audit trail and managed package
 * installer behind one boundary while `AdminService` handles the rest of the
 * WebUI surface.
 */
export class AdminPluginService {
  readonly #config: AppConfig;
  readonly #configPath: string | null;
  readonly #configEditor: ConfigEditor;
  readonly #host: PluginHost | undefined;
  readonly #audit: AuditTrail;
  readonly #installer: PluginInstaller | undefined;
  readonly #pluginUiTokens: PluginUiTokenSigner;

  constructor(options: AdminPluginServiceOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#configEditor = options.configEditor;
    this.#host = options.host;
    this.#audit = options.audit;
    this.#installer =
      options.host === undefined
        ? undefined
        : new PluginInstaller({
            config: options.config,
            configPath: options.configPath,
            configEditor: options.configEditor,
            host: options.host,
            coreVersion: options.version,
            logger: options.logger,
            ...(options.now === undefined ? {} : { now: options.now }),
          });
    this.#pluginUiTokens = new PluginUiTokenSigner(randomBytes(32), {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  catalog(): AdminPluginHostStatus {
    const host = this.#host;
    if (host === undefined) {
      return {
        enabled: false,
        total: 0,
        loaded: 0,
        failed: 0,
        plugins: [],
        message: PLUGINS_DISABLED_MESSAGE,
      };
    }
    const status = host.status();
    return {
      ...status,
      plugins: status.plugins.map((plugin) => ({
        ...plugin,
        managed: this.#installer?.isManaged(plugin.id) ?? false,
      })),
    };
  }

  async options(pluginId: string): Promise<PluginOptionsSnapshot> {
    const host = this.#requireHost();
    const plugin = this.#requirePlugin(pluginId);
    const raw = this.#config.plugins[pluginId]?.options ?? {};
    let normalized: unknown = raw;
    let error: string | null = null;
    try {
      normalized = host.validateOptions(pluginId, raw);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    let configHash: string | null = null;
    if (this.#configEditor.enabled) {
      try {
        configHash = (await this.#configEditor.read()).hash;
      } catch {
        configHash = null;
      }
    }
    return {
      plugin,
      options: raw,
      normalized,
      error,
      configHash,
      configPath: this.#configPath,
    };
  }

  async setEnabled(
    pluginId: string,
    enabled: boolean,
    expectedHash?: string,
  ): Promise<ConfigSaveResult & { plugin: AdminPluginStatus }> {
    this.#requirePlugin(pluginId);
    const result = await this.#configEditor.mutate((document) => {
      document.setIn(["plugins", pluginId, "enabled"], enabled);
    }, expectedHash);
    this.#record({
      action: enabled ? "admin.plugin.enabled" : "admin.plugin.disabled",
      detail: { pluginId },
    });
    return { ...result, plugin: this.#requirePlugin(pluginId) };
  }

  async saveOptions(
    pluginId: string,
    options: Record<string, unknown>,
    expectedHash?: string,
  ): Promise<PluginOptionsSnapshot & ConfigSaveResult> {
    const host = this.#requireHost();
    this.#requirePlugin(pluginId);
    let normalized: unknown;
    try {
      normalized = host.validateOptions(pluginId, options);
    } catch (error) {
      throw new AdminError(
        400,
        "invalid_plugin_options",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!isPlainRecord(normalized)) {
      throw new AdminError(400, "invalid_plugin_options", "插件配置必须是 JSON 对象。");
    }
    const result = await this.#configEditor.mutate((document) => {
      document.setIn(["plugins", pluginId, "options"], normalized);
    }, expectedHash);
    this.#record({
      action: "admin.plugin.options.updated",
      detail: { pluginId },
    });
    const refreshed = this.#requirePlugin(pluginId);
    return {
      ...result,
      plugin: refreshed,
      options: normalized,
      normalized,
      error: null,
      configHash: result.hash,
      configPath: result.path,
    };
  }

  uiPage(pluginId: string, pageId?: string): PluginUiPageDescriptor {
    const host = this.#requireHost();
    const plugin = this.#requirePlugin(pluginId);
    if (plugin.status !== "loaded") {
      throw new AdminError(409, "plugin_not_loaded", `插件未加载：${pluginId}`);
    }
    const page = host.adminUiPage(pluginId, pageId);
    if (page === null) {
      throw new AdminError(
        404,
        "plugin_ui_page_not_found",
        `插件没有可用的 iframe 页面：${pluginId}`,
      );
    }
    const token = this.#pluginUiTokens.sign(pluginId);
    const entry = page.entry.split("/").map(encodeURIComponent).join("/");
    return {
      pluginId,
      pageId: page.page.id,
      title: page.page.title,
      ...(page.page.description !== undefined ? { description: page.page.description } : {}),
      entry: page.entry,
      protocol: PLUGIN_UI_PROTOCOL_VERSION,
      url: `/admin/plugin-assets/${encodeURIComponent(token)}/${encodeURIComponent(pluginId)}/${entry}`,
    };
  }

  async readAsset(
    token: string,
    pluginId: string,
    relativePath: string,
  ): Promise<PluginUiAssetPayload> {
    const host = this.#requireHost();
    const verified = this.#pluginUiTokens.verify(token);
    if (verified === null || verified.pluginId !== pluginId) {
      throw new AdminError(403, "plugin_ui_token_invalid", "插件页面资源令牌无效或已过期。");
    }
    const plugin = this.#requirePlugin(pluginId);
    if (plugin.status !== "loaded") {
      throw new AdminError(404, "plugin_not_loaded", `插件未加载：${pluginId}`);
    }
    const asset = await host.resolveAdminUiAsset(pluginId, relativePath);
    if (asset === null) {
      throw new AdminError(404, "plugin_ui_asset_not_found", "插件页面资源不存在。");
    }
    const bytes = await readFile(asset.path).catch(() => null);
    if (bytes === null) {
      throw new AdminError(404, "plugin_ui_asset_not_found", "插件页面资源不存在。");
    }
    if (bytes.byteLength > 32 * 1024 * 1024) {
      throw new AdminError(413, "plugin_ui_asset_too_large", "插件页面资源过大。");
    }
    return {
      body: new Uint8Array(bytes),
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
    };
  }

  async dispatch(
    pluginId: string,
    request: Request,
    path: string,
    actor: PluginAdminActor,
  ): Promise<PluginAdminResult> {
    const host = this.#requireHost();
    this.#requirePlugin(pluginId);
    let result: PluginAdminResult | null;
    try {
      result = await host.dispatchAdmin(pluginId, request, path, actor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AdminError(
        /unknown plugin|not loaded/.test(message) ? 404 : 500,
        "plugin_admin_failed",
        message,
      );
    }
    if (result === null) {
      throw new AdminError(404, "plugin_route_not_found", "插件没有这个管理接口。");
    }
    if (!(result instanceof Response) && request.method !== "GET") {
      this.#record({
        action: "admin.plugin.route",
        detail: { pluginId, method: request.method, path },
      });
    }
    return result;
  }

  async previewUpload(file: File): Promise<PluginPackagePreview> {
    const installer = this.#requireInstaller();
    if (file.size > PLUGIN_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new AdminError(413, "plugin_archive_too_large", "插件包不能超过 20 MiB。");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    return this.#callInstaller(() => installer.previewUpload({ buffer, filename: file.name }));
  }

  async installUpload(
    uploadId: string,
    enable: boolean,
    expectedHash?: string,
  ): Promise<PluginActionResult> {
    const installer = this.#requireInstaller();
    const result = await this.#callInstaller(() =>
      installer.installUpload(uploadId, enable, expectedHash),
    );
    this.#recordInstall(result);
    return result;
  }

  async previewLocal(path: string): Promise<PluginPackagePreview> {
    const installer = this.#requireInstaller();
    return this.#callInstaller(() => installer.previewLocal(path));
  }

  async installLocal(
    path: string,
    enable: boolean,
    expectedHash?: string,
  ): Promise<PluginActionResult> {
    const installer = this.#requireInstaller();
    const result = await this.#callInstaller(() =>
      installer.installLocal(path, enable, expectedHash),
    );
    this.#recordInstall(result);
    return result;
  }

  async reload(pluginId: string): Promise<PluginActionResult> {
    const installer = this.#requireInstaller();
    const result = await this.#callInstaller(() => installer.reload(pluginId));
    this.#record({
      action: "admin.plugin.reloaded",
      detail: this.#installDetail(result),
    });
    return result;
  }

  async rollback(pluginId: string): Promise<PluginActionResult> {
    const installer = this.#requireInstaller();
    const result = await this.#callInstaller(() => installer.rollback(pluginId));
    this.#record({
      action: "admin.plugin.rolled_back",
      detail: this.#installDetail(result),
    });
    return result;
  }

  async uninstall(
    pluginId: string,
    deleteData: boolean,
    expectedHash?: string,
  ): Promise<PluginUninstallResult> {
    const installer = this.#requireInstaller();
    const managed = installer.isManaged(pluginId);
    const result = await this.#callInstaller(() =>
      installer.uninstall(pluginId, deleteData, expectedHash),
    );
    this.#record({
      action: "admin.plugin.uninstalled",
      detail: {
        pluginId,
        managed,
        deleteData,
        codeRemoved: result.codeRemoved,
        dataDeleted: result.dataDeleted,
      },
    });
    return result;
  }

  #recordInstall(result: PluginActionResult): void {
    const previousVersion = result.install?.previousVersion ?? null;
    this.#record({
      action: previousVersion === null ? "admin.plugin.installed" : "admin.plugin.updated",
      detail: this.#installDetail(result),
    });
  }

  #installDetail(result: PluginActionResult): Record<string, unknown> {
    return {
      pluginId: result.plugin.id,
      version: result.plugin.version,
      managed: result.install?.managed ?? false,
      archiveName: result.install?.archiveName ?? null,
      archiveSha256: result.install?.archiveSha256 ?? null,
    };
  }

  #requireHost(): PluginHost {
    if (this.#host === undefined) {
      throw new AdminError(503, "plugins_disabled", PLUGINS_DISABLED_MESSAGE);
    }
    return this.#host;
  }

  #requireInstaller(): PluginInstaller {
    this.#requireHost();
    if (this.#installer === undefined) {
      throw new AdminError(503, "plugins_disabled", PLUGINS_DISABLED_MESSAGE);
    }
    return this.#installer;
  }

  #requirePlugin(pluginId: string): AdminPluginStatus {
    const status = this.catalog();
    const plugin = status.plugins.find((item) => item.id === pluginId);
    if (plugin === undefined) {
      throw new AdminError(404, "plugin_not_found", `插件不存在：${pluginId}`);
    }
    return plugin;
  }

  async #callInstaller<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof PluginInstallError) {
        throw new AdminError(error.status, error.code, error.message, error.details);
      }
      throw error;
    }
  }

  #record(
    entry: Omit<AuditEntry, "ts" | "actorQq" | "chatKey" | "projectId" | "workspaceId">,
  ): void {
    this.#audit.record({
      ts: Date.now(),
      actorQq: null,
      chatKey: null,
      projectId: null,
      workspaceId: null,
      ...entry,
    });
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
