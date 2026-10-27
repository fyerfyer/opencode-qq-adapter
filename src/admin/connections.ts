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

  async saveJev(apiKey: string, expectedEnvHash?: string | null): Promise<ConnectionSaveResult> {
    const envPath = this.#envPath();
    if (envPath === null) {
      throw new AdminError(409, "env_unavailable", "当前进程没有关联配置文件，无法保存 Jev 密钥。");
    }
    const options = this.#roleplayOptions();
    if (options === null) {
      throw new AdminError(409, "roleplay_not_configured", "当前没有配置 Roleplay 插件。");
    }
    const keyName = this.#apiKeyEnv(options);
    const value = apiKey.trim();
    if (value.length === 0) {
      throw new AdminError(400, "invalid_api_key", "Jev API Key 不能为空。");
    }
    if (value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw new AdminError(400, "invalid_api_key", "Jev API Key 不合法。");
    }

    const envResult = await new EnvEditor(envPath).update({ [keyName]: value }, expectedEnvHash);
    process.env[keyName] = value;

    let reload: ConnectionSaveResult["reload"] = null;
    const warnings: string[] = [];
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
        this.#logger.warn({ err: error }, "Roleplay reload after Jev key update failed");
        reload = { ok: false, warnings: [message], error: message };
        warnings.push(`Roleplay 重载失败：${message}`);
      }
    }

    const snapshot = await this.snapshot();
    this.#record({
      action: "admin.connection.jev.updated",
      detail: { apiKeyEnv: keyName },
    });
    return {
      ...snapshot,
      backup: envResult.backup,
      restartRequired: [],
      warnings,
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
      : "JEV_API_KEY";
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
