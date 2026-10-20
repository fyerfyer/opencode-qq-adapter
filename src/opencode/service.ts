import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Logger } from "pino";
import semver from "semver";
import type { AppConfig } from "../config/schema.js";
import type { AgentHealth } from "../ports/agent.js";
import { AgentError, AgentUnavailableError, AgentVersionMismatchError } from "./errors.js";
import { basicAuthHeader } from "./mappers.js";

export type Client = ReturnType<typeof OpenCode.make>;

interface EndpointInfo {
  url: string;
  headers?: Record<string, string>;
}

type OpenCodeConfig = AppConfig["opencode"];

/**
 * Owns the OpenCode client lifecycle: discovery, optional ensure, version
 * checks, health caching and endpoint invalidation.
 */
export class OpenCodeService {
  readonly #config: OpenCodeConfig;
  readonly #logger: Logger;
  #client: Client | null = null;
  #endpoint: EndpointInfo | null = null;
  #health: AgentHealth | null = null;
  #lastError: string | null = null;
  #onClientChanged: ((client: Client | null) => void) | undefined;

  constructor(config: OpenCodeConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  setOnClientChanged(callback: (client: Client | null) => void): void {
    this.#onClientChanged = callback;
  }

  getLastError(): string | null {
    return this.#lastError;
  }

  async getClient(): Promise<Client> {
    if (this.#client !== null) return this.#client;

    const service = this.#config.service;
    let endpoint: EndpointInfo;
    if (service.mode === "off" || service.base_url !== null) {
      const url = service.base_url;
      if (!url) {
        throw new AgentUnavailableError("opencode.service.base_url is required when mode is 'off'");
      }
      endpoint = { url, headers: basicAuthHeader(service.username, service.password) };
    } else if (service.mode === "ensure") {
      const versionPredicate = this.#versionPredicate();
      const ensured = await Service.ensure({
        ...(versionPredicate ? { version: versionPredicate } : {}),
        command: service.command,
        onStart: (reason, previousVersion) => {
          this.#logger.info({ reason, previousVersion }, "Starting OpenCode service");
        },
      });
      endpoint = { url: ensured.url, headers: Service.headers(ensured) };
    } else {
      const versionPredicate = this.#versionPredicate();
      const discovered = await Service.discover(
        versionPredicate ? { version: versionPredicate } : undefined,
      );
      if (discovered === undefined) {
        throw new AgentUnavailableError(
          "No compatible OpenCode service was discovered. Start 'opencode serve --service' or configure opencode.service.base_url.",
        );
      }
      endpoint = { url: discovered.url, headers: Service.headers(discovered) };
    }

    const client = OpenCode.make({
      baseUrl: endpoint.url,
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
    });
    const changed =
      this.#endpoint === null ||
      this.#endpoint.url !== endpoint.url ||
      JSON.stringify(this.#endpoint.headers) !== JSON.stringify(endpoint.headers);
    this.#endpoint = endpoint;
    this.#client = client;
    this.#logger.info({ url: endpoint.url, mode: service.mode }, "OpenCode client ready");
    if (changed) this.#onClientChanged?.(client);
    return client;
  }

  async health(force = false): Promise<AgentHealth> {
    const now = Date.now();
    if (
      !force &&
      this.#health !== null &&
      now - this.#health.checkedAt < this.#config.health_cache_ms
    ) {
      return this.#health;
    }
    try {
      const client = await this.getClient();
      const info = await client.server.info({ signal: AbortSignal.timeout(5000) });
      this.#assertVersion(info.version);
      this.#lastError = null;
      this.#health = {
        healthy: true,
        version: info.version,
        url: this.#endpoint?.url ?? null,
        checkedAt: now,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = message;
      this.#health = {
        healthy: false,
        version: null,
        url: this.#endpoint?.url ?? null,
        checkedAt: now,
        error: message,
      };
      this.#invalidateClient();
    }
    return this.#health;
  }

  async stop(): Promise<void> {
    this.#onClientChanged?.(null);
    if (this.#config.service.mode === "ensure" && this.#config.service.manage_lifecycle) {
      await Service.stop().catch((error) => {
        this.#logger.warn({ err: error }, "Failed to stop managed OpenCode service");
      });
    }
    this.#client = null;
    this.#endpoint = null;
    this.#health = null;
    this.#onClientChanged = undefined;
  }

  #assertVersion(version: string): void {
    const expected = this.#config.service.version;
    if (expected === null) return;
    if (!semver.satisfies(version, expected, { includePrerelease: true })) {
      throw new AgentVersionMismatchError(version, expected);
    }
  }

  #versionPredicate(): ((version: string) => boolean) | undefined {
    const expected = this.#config.service.version;
    if (expected === null) return undefined;
    if (semver.validRange(expected) === null) {
      throw new AgentError(`Invalid OpenCode version range: ${expected}`);
    }
    return (version: string) => semver.satisfies(version, expected, { includePrerelease: true });
  }

  #invalidateClient(): void {
    if (this.#client === null) return;
    this.#client = null;
    this.#endpoint = null;
    this.#onClientChanged?.(null);
  }
}
