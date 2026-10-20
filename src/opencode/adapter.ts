import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Logger } from "pino";
import semver from "semver";
import type { AppConfig } from "../config/schema.js";
import type {
  AgentEvent,
  AgentEventStatus,
  AgentHealth,
  AgentMessage,
  AgentPort,
  AgentPromptInput,
  AgentPromptReceipt,
  AgentSession,
  AgentSessionInput,
} from "../ports/agent.js";

type Client = ReturnType<typeof OpenCode.make>;
type OpenCodeConfig = AppConfig["opencode"];

interface EndpointInfo {
  url: string;
  headers?: Record<string, string>;
}

interface RawEvent {
  type: string;
  data?: unknown;
}

export class AgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
  }
}

export class AgentUnavailableError extends AgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentUnavailableError";
  }
}

export class AgentVersionMismatchError extends AgentError {
  constructor(actual: string, expected: string) {
    super(`OpenCode service version ${actual} does not satisfy ${expected}`);
    this.name = "AgentVersionMismatchError";
  }
}

export class OpenCodeAgent implements AgentPort {
  readonly #config: OpenCodeConfig;
  readonly #logger: Logger;
  #client: Client | null = null;
  #endpoint: EndpointInfo | null = null;
  #health: AgentHealth | null = null;
  #lastError: string | null = null;

  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #eventLoop: Promise<void> | null = null;
  #eventAbort: AbortController | null = null;
  #eventConnected = false;
  #lastEventAt: number | null = null;

  constructor(config: OpenCodeConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  async start(): Promise<void> {
    const health = await this.health(true);
    if (health.healthy) {
      this.#startEventLoop();
    } else {
      this.#logger.warn(
        { error: health.error },
        "OpenCode service is not healthy at startup; it will be retried on demand",
      );
    }
  }

  async stop(): Promise<void> {
    this.#eventAbort?.abort();
    const loop = this.#eventLoop;
    this.#eventLoop = null;
    this.#eventAbort = null;
    this.#eventConnected = false;
    if (loop !== null) {
      await loop.catch(() => undefined);
    }
    if (this.#config.service.mode === "ensure" && this.#config.service.manage_lifecycle) {
      await Service.stop().catch((error) => {
        this.#logger.warn({ err: error }, "Failed to stop managed OpenCode service");
      });
    }
    this.#client = null;
    this.#endpoint = null;
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
      const client = await this.#getClient();
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

  async createSession(input: AgentSessionInput): Promise<AgentSession> {
    const client = await this.#getHealthyClient();
    const model = input.model ? parseModelRef(input.model) : undefined;
    const session = await client.session.create({
      location: { directory: input.directory },
      ...(input.title ? { title: input.title } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
    });
    this.#logger.info(
      {
        sessionId: session.id,
        directory: input.directory,
        agent: session.agent,
        model: session.model,
      },
      "OpenCode session created",
    );
    return mapSession(session);
  }

  async getSession(sessionId: string): Promise<AgentSession | null> {
    const client = await this.#getClient();
    try {
      return mapSession(await client.session.get({ sessionID: sessionId }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptReceipt> {
    const client = await this.#getHealthyClient();
    const inbox = await client.session.prompt({
      sessionID: input.sessionId,
      text: input.text,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    });
    return { messageId: inbox.id, created: inbox.time.created };
  }

  async waitForCompletion(sessionId: string, signal?: AbortSignal): Promise<void> {
    const client = await this.#getClient();
    await client.session.wait({ sessionID: sessionId }, signal ? { signal } : undefined);
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const client = await this.#getClient();
    const result = await client.session.interrupt({ sessionID: sessionId });
    return result.interrupted;
  }

  async listMessages(sessionId: string, limit = 50): Promise<AgentMessage[]> {
    const client = await this.#getClient();
    const response = await client.message.list({
      sessionID: sessionId,
      limit,
      order: "desc",
    });
    return response.data.map(mapMessage);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  eventStatus(): AgentEventStatus {
    return {
      connected: this.#eventConnected,
      lastEventAt: this.#lastEventAt,
      lastError: this.#lastError,
    };
  }

  getLastError(): string | null {
    return this.#lastError;
  }

  async #getHealthyClient(): Promise<Client> {
    const client = await this.#getClient();
    const health = await this.health();
    if (!health.healthy) {
      throw new AgentUnavailableError(health.error ?? "OpenCode service is unavailable");
    }
    this.#startEventLoop();
    return client;
  }

  async #getClient(): Promise<Client> {
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
    if (changed) {
      this.#restartEventLoop();
    }
    return client;
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

  #restartEventLoop(): void {
    this.#eventAbort?.abort();
    this.#eventLoop = null;
    this.#startEventLoop();
  }

  #invalidateClient(): void {
    if (this.#client === null) return;
    this.#client = null;
    this.#endpoint = null;
    this.#eventAbort?.abort();
    this.#eventAbort = null;
    this.#eventLoop = null;
    this.#eventConnected = false;
  }

  #startEventLoop(): void {
    if (this.#eventLoop !== null || this.#client === null) return;
    const controller = new AbortController();
    this.#eventAbort = controller;
    this.#eventLoop = this.#runEventLoop(controller.signal).finally(() => {
      if (this.#eventAbort === controller) {
        this.#eventAbort = null;
        this.#eventLoop = null;
        this.#eventConnected = false;
      }
    });
  }

  async #runEventLoop(signal: AbortSignal): Promise<void> {
    let backoff = this.#config.event_reconnect_ms;
    while (!signal.aborted) {
      const client = this.#client;
      if (client === null) return;
      try {
        this.#eventConnected = true;
        this.#logger.info("Subscribed to OpenCode events");
        for await (const raw of client.event.subscribe({ signal })) {
          this.#handleEvent(raw);
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#lastError = message;
        this.#logger.warn({ err: error }, "OpenCode event stream disconnected");
      } finally {
        this.#eventConnected = false;
      }
      if (signal.aborted) return;
      const wait = Math.min(backoff, this.#config.event_reconnect_max_ms);
      backoff = Math.min(backoff * 2, this.#config.event_reconnect_max_ms);
      try {
        await delay(wait, undefined, { signal });
      } catch {
        return;
      }
    }
  }

  #handleEvent(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const event = raw as RawEvent;
    if (typeof event.type !== "string") return;
    this.#lastEventAt = Date.now();
    const sessionId = extractSessionId(event);
    const mapped: AgentEvent = {
      type: event.type,
      sessionId,
      data: event.data ?? null,
      receivedAt: this.#lastEventAt,
    };
    if (event.type === "session.execution.failed") {
      this.#lastError = formatStructuredError(
        (event.data as Record<string, unknown> | undefined)?.error,
      );
    } else if (event.type === "session.execution.succeeded") {
      this.#lastError = null;
    }
    for (const listener of this.#listeners) {
      try {
        listener(mapped);
      } catch (error) {
        this.#logger.error({ err: error, event: event.type }, "OpenCode event listener failed");
      }
    }
  }
}

export function parseModelRef(value: string): { providerID: string; id: string; variant?: string } {
  const [modelPart = value, variant] = value.split("#", 2);
  const slash = modelPart.indexOf("/");
  if (slash <= 0 || slash === modelPart.length - 1) {
    throw new AgentError(`Invalid model reference '${value}'; expected 'provider/model'`);
  }
  const providerID = modelPart.slice(0, slash);
  const id = modelPart.slice(slash + 1);
  return { providerID, id, ...(variant ? { variant } : {}) };
}

function basicAuthHeader(username: string, password: string): Record<string, string> | undefined {
  if (password.length === 0) return undefined;
  const user = username.length > 0 ? username : "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const cause = (error as { cause?: { status?: number } }).cause;
  if (cause?.status === 404) return true;
  const message = error instanceof Error ? error.message : "";
  return /not.?found/i.test(message);
}

function extractSessionId(event: RawEvent): string | null {
  if (event.data === null || typeof event.data !== "object") return null;
  const data = event.data as Record<string, unknown>;
  if (typeof data.sessionID === "string") return data.sessionID;
  if (typeof data.sessionId === "string") return data.sessionId;
  const item = data.item;
  if (item !== null && typeof item === "object") {
    const sessionID = (item as Record<string, unknown>).sessionID;
    if (typeof sessionID === "string") return sessionID;
  }
  return null;
}

function formatStructuredError(value: unknown): string {
  if (value === null || typeof value !== "object") return "Unknown OpenCode error";
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "error";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
  return `${type}: ${message}`;
}

function mapSession(session: {
  id: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  projectID?: string;
  time?: { created?: number; updated?: number };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}): AgentSession {
  return {
    id: session.id,
    title: session.title ?? null,
    agent: session.agent ?? null,
    model: session.model ? `${session.model.providerID}/${session.model.id}` : null,
    projectId: session.projectID ?? null,
    created: session.time?.created ?? null,
    updated: session.time?.updated ?? null,
    cost: session.cost ?? 0,
    tokens: session.tokens
      ? {
          input: session.tokens.input,
          output: session.tokens.output,
          reasoning: session.tokens.reasoning,
          cacheRead: session.tokens.cache.read,
          cacheWrite: session.tokens.cache.write,
        }
      : null,
  };
}

function mapMessage(message: {
  id: string;
  type: string;
  time?: { created?: number };
  text?: string;
  error?: { type: string; message: string };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  content?: Array<{ type: string; text?: string }>;
}): AgentMessage {
  const text =
    message.type === "assistant"
      ? (message.content ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("")
      : (message.text ?? "");
  return {
    id: message.id,
    type: message.type,
    text,
    created: message.time?.created ?? 0,
    error: message.error ? `${message.error.type}: ${message.error.message}` : null,
    cost: message.cost ?? null,
    tokens: message.tokens
      ? {
          input: message.tokens.input,
          output: message.tokens.output,
          reasoning: message.tokens.reasoning,
          cacheRead: message.tokens.cache.read,
          cacheWrite: message.tokens.cache.write,
        }
      : null,
  };
}
