import { parseDocument } from "yaml";
import { defaultEnvPath } from "../config/paths.js";
import type { AppConfig } from "../config/schema.js";
import type { AuditEntry } from "../domain/audit.js";
import type { AuditTrail } from "../observability/audit.js";
import type { HealthService } from "../observability/health.js";
import type { PluginHost } from "../plugins/host.js";
import type { ConfigEditor } from "./config-editor.js";
import { EnvEditor } from "./env-editor.js";
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

export interface ConnectionsSnapshot {
  envPath: string | null;
  envHash: string | null;
  napcat: NapCatConnectionSnapshot;
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
 * is configured, never the value itself. NapCat changes are restart-required.
 * Plugin-owned settings and secrets stay in the plugin admin UI.
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

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.trim() === needle;
  if (Array.isArray(value)) return value.some((item) => containsString(item, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsString(item, needle));
  }
  return false;
}
