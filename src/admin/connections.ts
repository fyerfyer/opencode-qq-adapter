import { parseDocument } from "yaml";
import { defaultEnvPath } from "../config/paths.js";
import type { AppConfig } from "../config/schema.js";
import type { AuditEntry } from "../domain/audit.js";
import type { AuditTrail } from "../observability/audit.js";
import type { HealthService } from "../observability/health.js";
import type { PluginHost, PluginStatus } from "../plugins/host.js";
import type { ConfigEditor } from "./config-editor.js";
import { EnvEditor, type EnvSnapshot } from "./env-editor.js";
import { AdminError } from "./errors.js";

export interface ConnectionStatus {
  connected: boolean;
  loginOk: boolean | null;
  selfId: number | null;
  lastConnectedAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
}

export interface NapCatConnectionSnapshot {
  url: string;
  tokenConfigured: boolean;
  status: ConnectionStatus;
}

export interface JevConnectionSnapshot {
  available: boolean;
  pluginStatus: PluginStatus["status"] | null;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  baseUrl: string | null;
  endpoint: string | null;
  model: string | null;
  judge: string | null;
}

export interface ConnectionsSnapshot {
  envPath: string | null;
  envHash: string | null;
  napcat: NapCatConnectionSnapshot;
  jev: JevConnectionSnapshot | null;
}

export interface ConnectionSaveResult extends ConnectionsSnapshot {
  backup: string | null;
  restartRequired: string[];
  warnings: string[];
  reload: { ok: boolean; warnings: string[]; error?: string } | null;
}

export interface AdminConnectionServiceOptions {
  config: AppConfig;
  configPath: string | null;
  configEditor: ConfigEditor;
  health: Pick<HealthService, "onebotStatus">;
  plugins?: Pick<PluginHost, "status" | "reloadPlugin">;
  audit: Pick<AuditTrail, "record">;
  logger: { warn: (obj: object, message?: string) => void };
}

export interface JevConnectionInput {
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  model?: string;
  expectedEnvHash?: string | null;
}

export interface PluginSecretInput {
  key: string;
  value: string;
  expectedEnvHash?: string | null;
}

export interface PluginSecretResult {
  key: string;
  configured: boolean;
  backup: string | null;
  reload: { ok: boolean; warnings: string[]; error?: string } | null;
}

/**
 * Admin-side management for external connection credentials.
 *
 * Secrets live only in the private .env file. Snapshots expose whether a value
 * is configured, never the value itself. NapCat changes are restart-required;
 * Jev key changes force a roleplay reload so the judge is recreated.
 */
export class AdminConnectionService {
  readonly #config: AppConfig;
  readonly #configPath: string | null;
  readonly #configEditor: ConfigEditor;
  readonly #health: Pick<HealthService, "onebotStatus">;
  readonly #plugins: Pick<PluginHost, "status" | "reloadPlugin"> | undefined;
  readonly #audit: Pick<AuditTrail, "record">;
  readonly #logger: AdminConnectionServiceOptions["logger"];

  constructor(options: AdminConnectionServiceOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#configEditor = options.configEditor;
    this.#health = options.health;
    this.#plugins = options.plugins;
    this.#audit = options.audit;
    this.#logger = options.logger;
  }

  async snapshot(): Promise<ConnectionsSnapshot> {
    const envPath = this.#envPath();
    const env = envPath === null ? null : await new EnvEditor(envPath).read();
    const status = this.#health.onebotStatus();
    const roleplay = this.#roleplayOptions();
    return {
      envPath,
      envHash: env?.hash ?? null,
      napcat: {
        url: this.#config.onebot.url,
        tokenConfigured:
          this.#config.onebot.access_token.trim().length > 0 ||
          (env?.values.NAPCAT_ACCESS_TOKEN?.trim().length ?? 0) > 0,
        status: {
          connected: status.connected,
          loginOk: status.loginOk,
          selfId: status.selfId,
          lastConnectedAt: status.lastConnectedAt,
          lastEventAt: status.lastEventAt,
          lastError: status.lastError,
        },
      },
      jev:
        roleplay === null
          ? null
          : {
              available: true,
              pluginStatus: this.#roleplayStatus(),
              apiKeyEnv: this.#apiKeyEnvName(roleplay),
              apiKeyConfigured: this.#apiKeyConfigured(roleplay, env),
              baseUrl: text(roleplay.jev_base_url),
              endpoint: text(roleplay.jev_endpoint),
              model: text(roleplay.jev_model),
              judge: text(roleplay.sticker_judge),
            },
    };
  }

  async saveNapcat(input: {
    url: string;
    accessToken?: string;
    expectedEnvHash?: string | null;
  }): Promise<ConnectionSaveResult> {
    const envPath = this.#envPath();
    if (envPath === null) {
      throw new AdminError(409, "env_unavailable", "当前进程没有关联配置文件，无法保存连接配置。");
    }
    if (!this.#configEditor.enabled) {
      throw new AdminError(409, "config_unavailable", "当前进程没有关联配置文件路径。");
    }

    const url = validateWsUrl(input.url);
    const token = input.accessToken?.trim();
    if (token !== undefined && token.length > 0 && /[\r\n\0]/.test(token)) {
      throw new AdminError(400, "invalid_token", "NapCat Access Token 不能包含换行或空字符。");
    }
    if (token !== undefined && token.length > 4096) {
      throw new AdminError(400, "invalid_token", "NapCat Access Token 过长。");
    }

    const updates: Record<string, string> = { NAPCAT_WS_URL: url };
    if (token !== undefined && token.length > 0) updates.NAPCAT_ACCESS_TOKEN = token;
    const envResult = await new EnvEditor(envPath).update(updates, input.expectedEnvHash);
    process.env.NAPCAT_WS_URL = url;
    if (token !== undefined && token.length > 0) process.env.NAPCAT_ACCESS_TOKEN = token;

    const warnings: string[] = ["NapCat URL/Token 已保存；需要重启 bridge 后才会使用新连接。"];
    let configBackup: string | null = null;
    const current = await this.#configEditor.read();
    const document = parseDocument(current.content);
    const currentUrl = document.getIn(["onebot", "url"]);
    const currentToken = document.getIn(["onebot", "access_token"]);
    const urlManaged = typeof currentUrl === "string" && currentUrl.includes("${NAPCAT_WS_URL");
    const tokenManaged =
      typeof currentToken === "string" && currentToken.includes("${NAPCAT_ACCESS_TOKEN");
    if (!urlManaged || !tokenManaged) {
      const saved = await this.#configEditor.mutate((yaml) => {
        yaml.setIn(["onebot", "url"], ["$", "{NAPCAT_WS_URL}"].join(""));
        yaml.setIn(["onebot", "access_token"], ["$", "{NAPCAT_ACCESS_TOKEN}"].join(""));
      }, current.hash);
      configBackup = saved.backup;
      warnings.push("已将 YAML 的 onebot 连接字段改为环境变量引用。");
    }

    const snapshot = await this.snapshot();
    this.#record({
      action: "admin.connection.napcat.updated",
      detail: { url, tokenUpdated: token !== undefined && token.length > 0 },
    });
    return {
      ...snapshot,
      napcat: {
        ...snapshot.napcat,
        url,
        tokenConfigured:
          (token !== undefined && token.length > 0) || snapshot.napcat.tokenConfigured,
      },
      backup: envResult.backup ?? configBackup,
      restartRequired: ["onebot"],
      warnings,
      reload: null,
    };
  }

  async saveJev(input: JevConnectionInput): Promise<ConnectionSaveResult> {
    const options = this.#roleplayOptions();
    if (options === null) {
      throw new AdminError(409, "roleplay_not_configured", "当前没有配置 Roleplay 插件。");
    }
    const keyName = this.#apiKeyEnv(options);
    const apiKey = input.apiKey?.trim();
    const baseUrl = input.baseUrl === undefined ? undefined : validateJevBaseUrl(input.baseUrl);
    const endpoint =
      input.endpoint === undefined ? undefined : validateJevText(input.endpoint, "Endpoint", 200);
    const model =
      input.model === undefined ? undefined : validateJevText(input.model, "Model", 200);
    if (
      (apiKey === undefined || apiKey.length === 0) &&
      baseUrl === undefined &&
      endpoint === undefined &&
      model === undefined
    ) {
      throw new AdminError(400, "nothing_to_update", "没有需要保存的 Jev 配置。");
    }
    if (apiKey !== undefined && apiKey.length > 0) {
      if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
        throw new AdminError(400, "invalid_api_key", "Jev API Key 不合法。");
      }
    }

    let envBackup: string | null = null;
    if (apiKey !== undefined && apiKey.length > 0) {
      const envPath = this.#envPath();
      if (envPath === null) {
        throw new AdminError(
          409,
          "env_unavailable",
          "当前进程没有关联配置文件，无法保存 Jev 密钥。",
        );
      }
      const envResult = await new EnvEditor(envPath).update(
        { [keyName]: apiKey },
        input.expectedEnvHash,
      );
      envBackup = envResult.backup;
      process.env[keyName] = apiKey;
    }

    let configBackup: string | null = null;
    const warnings: string[] = [];
    if (baseUrl !== undefined || endpoint !== undefined || model !== undefined) {
      if (!this.#configEditor.enabled) {
        throw new AdminError(409, "config_unavailable", "当前进程没有关联配置文件路径。");
      }
      const current = await this.#configEditor.read();
      const saved = await this.#configEditor.mutate((document) => {
        if (baseUrl !== undefined) {
          document.setIn(["plugins", "roleplay", "options", "jev_base_url"], baseUrl);
        }
        if (endpoint !== undefined) {
          document.setIn(["plugins", "roleplay", "options", "jev_endpoint"], endpoint);
        }
        if (model !== undefined) {
          document.setIn(["plugins", "roleplay", "options", "jev_model"], model);
        }
      }, current.hash);
      configBackup = saved.backup;
      warnings.push("已将 Jev Base URL / Endpoint / Model 写入 Roleplay 配置。");
    }

    let reload: ConnectionSaveResult["reload"] = null;
    if (this.#plugins !== undefined) {
      try {
        const status = await this.#plugins.reloadPlugin("roleplay");
        reload = {
          ok: status === "loaded",
          warnings: status === "loaded" ? [] : [`Roleplay 重载后状态为 ${status}`],
        };
        if (status !== "loaded") warnings.push(`Roleplay 当前状态：${status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.warn({ err: error }, "Roleplay reload after Jev update failed");
        reload = { ok: false, warnings: [message], error: message };
        warnings.push(`Roleplay 重载失败：${message}`);
      }
    }

    const snapshot = await this.snapshot();
    const detail: Record<string, unknown> = { apiKeyEnv: keyName };
    if (baseUrl !== undefined) detail.baseUrl = baseUrl;
    if (endpoint !== undefined) detail.endpoint = endpoint;
    if (model !== undefined) detail.model = model;
    this.#record({
      action: "admin.connection.jev.updated",
      detail,
    });
    return {
      ...snapshot,
      backup: envBackup ?? configBackup,
      restartRequired: [],
      warnings,
      reload,
    };
  }

  /**
   * Write a secret referenced by a plugin's options to `.env`, then reload that
   * plugin so it can recreate clients that captured the old value.
   *
   * The key must already appear in the plugin's options (for example
   * `jev_api_key_env: TYPESAFE_API_KEY`). This prevents a sandboxed plugin UI
   * from overwriting unrelated environment variables.
   */
  async savePluginSecret(pluginId: string, input: PluginSecretInput): Promise<PluginSecretResult> {
    const plugin = this.#config.plugins[pluginId];
    if (plugin === undefined) {
      throw new AdminError(404, "plugin_not_found", `插件 ${pluginId} 不存在。`);
    }
    const key = input.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new AdminError(400, "invalid_secret_key", "环境变量名不合法。");
    }
    if (!containsString(plugin.options, key)) {
      throw new AdminError(
        400,
        "plugin_secret_not_referenced",
        `插件 ${pluginId} 的 options 没有引用环境变量 ${key}。`,
      );
    }
    const value = input.value.trim();
    if (value.length === 0 || value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw new AdminError(400, "invalid_secret_value", "密钥不能为空或包含换行/空字符。");
    }
    const envPath = this.#envPath();
    if (envPath === null) {
      throw new AdminError(409, "env_unavailable", "当前进程没有关联配置文件，无法保存插件密钥。");
    }

    const envResult = await new EnvEditor(envPath).update({ [key]: value }, input.expectedEnvHash);
    process.env[key] = value;

    let reload: PluginSecretResult["reload"] = null;
    if (this.#plugins !== undefined) {
      try {
        const status = await this.#plugins.reloadPlugin(pluginId);
        reload = {
          ok: status === "loaded",
          warnings: status === "loaded" ? [] : [`插件重载后状态为 ${status}`],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.warn({ err: error, pluginId }, "Plugin reload after secret update failed");
        reload = { ok: false, warnings: [message], error: message };
      }
    }

    this.#record({
      action: "admin.plugin.secret.updated",
      detail: { pluginId, key },
    });
    return {
      key,
      configured: value.length > 0,
      backup: envResult.backup,
      reload,
    };
  }

  #envPath(): string | null {
    if (this.#configPath === null) return null;
    return defaultEnvPath(this.#configPath);
  }

  #roleplayOptions(): Record<string, unknown> | null {
    if (!Object.hasOwn(this.#config.plugins, "roleplay")) return null;
    return this.#config.plugins.roleplay?.options ?? {};
  }

  #roleplayStatus(): PluginStatus["status"] | null {
    return (
      this.#plugins?.status().plugins.find((plugin) => plugin.id === "roleplay")?.status ?? null
    );
  }

  #apiKeyEnv(options: Record<string, unknown>): string {
    const name = this.#apiKeyEnvName(options);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new AdminError(400, "invalid_api_key_env", "Roleplay 的 Jev 密钥环境变量名不合法。");
    }
    return name;
  }

  #apiKeyEnvName(options: Record<string, unknown>): string {
    const configured = options.jev_api_key_env;
    return typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : "TYPESAFE_API_KEY";
  }

  #apiKeyConfigured(options: Record<string, unknown>, env: EnvSnapshot | null): boolean {
    const name = this.#apiKeyEnvName(options);
    return (
      (process.env[name]?.trim().length ?? 0) > 0 || (env?.values[name]?.trim().length ?? 0) > 0
    );
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

function validateWsUrl(value: string): string {
  const url = value.trim();
  if (url.length === 0 || url.length > 2000 || /\s/.test(url)) {
    throw new AdminError(400, "invalid_napcat_url", "NapCat WebSocket URL 不合法。");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdminError(400, "invalid_napcat_url", "NapCat WebSocket URL 不合法。");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new AdminError(
      400,
      "invalid_napcat_url",
      "NapCat WebSocket URL 必须以 ws:// 或 wss:// 开头。",
    );
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new AdminError(
      400,
      "invalid_napcat_url",
      "NapCat URL 不要包含 token、用户名或 query 参数；Access Token 请单独填写。",
    );
  }
  return url;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.trim() === needle;
  if (Array.isArray(value)) return value.some((item) => containsString(item, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsString(item, needle));
  }
  return false;
}

function validateJevBaseUrl(value: string): string {
  const url = value.trim();
  if (url.length === 0 || url.length > 2000 || /\s/.test(url)) {
    throw new AdminError(400, "invalid_jev_base_url", "Jev Base URL 不合法。");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdminError(400, "invalid_jev_base_url", "Jev Base URL 不合法。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AdminError(
      400,
      "invalid_jev_base_url",
      "Jev Base URL 必须以 http:// 或 https:// 开头。",
    );
  }
  return url;
}

function validateJevText(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength || /[\r\n\0]/.test(text)) {
    throw new AdminError(400, "invalid_jev_setting", `${label} 不合法。`);
  }
  return text;
}
