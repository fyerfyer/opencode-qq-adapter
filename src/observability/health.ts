import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { AgentPort } from "../ports/agent.js";
import type { OneBotPort } from "../ports/onebot.js";
import type { StorePort } from "../ports/store.js";

export interface HealthSnapshot {
  status: "ok" | "degraded" | "error";
  version: string;
  uptimeSec: number;
  timestamp: string;
  onebot: {
    mode: "forward";
    connected: boolean;
    selfId: number | null;
    lastEventAt: number | null;
    lastError: string | null;
  };
  opencode: {
    mode: string;
    healthy: boolean;
    version: string | null;
    url: string | null;
    checkedAt: number;
    error: string | null;
  };
  db: { ok: boolean };
  queue: { depth: number; active: number };
  conversations: { active: number };
}

export class HealthService {
  readonly #config: AppConfig;
  readonly #onebot: OneBotPort;
  readonly #agent: AgentPort;
  readonly #store: StorePort;
  readonly #conversations: { activeRuns(): number; queuedRuns(): number };
  readonly #logger: Logger;
  readonly #startedAt = Date.now();
  readonly #version: string;

  constructor(deps: {
    config: AppConfig;
    onebot: OneBotPort;
    agent: AgentPort;
    store: StorePort;
    conversations: { activeRuns(): number; queuedRuns(): number };
    logger: Logger;
    version?: string;
  }) {
    this.#config = deps.config;
    this.#onebot = deps.onebot;
    this.#agent = deps.agent;
    this.#store = deps.store;
    this.#conversations = deps.conversations;
    this.#logger = deps.logger;
    this.#version = deps.version ?? "0.1.0";
  }

  async snapshot(): Promise<HealthSnapshot> {
    const onebotStatus = this.#onebot.status();
    const dbOk = this.#store.ping();
    let agentHealth: Awaited<ReturnType<AgentPort["health"]>>;
    try {
      agentHealth = await this.#agent.health();
    } catch (error) {
      this.#logger.warn({ err: error }, "Health check could not reach OpenCode");
      agentHealth = {
        healthy: false,
        version: null,
        url: null,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const active = this.#conversations.activeRuns();
    const depth = this.#conversations.queuedRuns();
    const status: HealthSnapshot["status"] = !dbOk
      ? "error"
      : onebotStatus.connected && agentHealth.healthy
        ? "ok"
        : "degraded";

    return {
      status,
      version: this.#version,
      uptimeSec: Math.floor((Date.now() - this.#startedAt) / 1000),
      timestamp: new Date().toISOString(),
      onebot: {
        mode: onebotStatus.mode,
        connected: onebotStatus.connected,
        selfId: onebotStatus.selfId,
        lastEventAt: onebotStatus.lastEventAt,
        lastError: onebotStatus.lastError,
      },
      opencode: {
        mode: this.#config.opencode.service.mode,
        healthy: agentHealth.healthy,
        version: agentHealth.version,
        url: agentHealth.url,
        checkedAt: agentHealth.checkedAt,
        error: agentHealth.error,
      },
      db: { ok: dbOk },
      queue: { depth, active },
      conversations: { active },
    };
  }
}
