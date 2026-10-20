import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { AgentEvent, AgentEventStatus } from "../ports/agent.js";
import { extractSessionId, formatStructuredError, type RawEvent } from "./mappers.js";
import type { Client } from "./service.js";

type OpenCodeConfig = AppConfig["opencode"];

/**
 * Consumes the live OpenCode event stream with reconnect/backoff. Event
 * delivery is intentionally best-effort; final run state is reconciled via
 * session.wait() and message history.
 */
export class OpenCodeEventStream {
  readonly #config: OpenCodeConfig;
  readonly #getClient: () => Promise<Client>;
  readonly #logger: Logger;
  readonly #onEvent: (event: AgentEvent) => void;
  #loop: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #connected = false;
  #lastEventAt: number | null = null;
  #lastError: string | null = null;

  constructor(options: {
    config: OpenCodeConfig;
    getClient: () => Promise<Client>;
    logger: Logger;
    onEvent: (event: AgentEvent) => void;
  }) {
    this.#config = options.config;
    this.#getClient = options.getClient;
    this.#logger = options.logger;
    this.#onEvent = options.onEvent;
  }

  start(): void {
    if (this.#loop !== null) return;
    const controller = new AbortController();
    this.#abort = controller;
    this.#loop = this.#run(controller.signal).finally(() => {
      if (this.#abort === controller) {
        this.#abort = null;
        this.#loop = null;
        this.#connected = false;
      }
    });
  }

  restart(): void {
    this.#abort?.abort();
    this.#loop = null;
    this.start();
  }

  async stop(): Promise<void> {
    this.#abort?.abort();
    const loop = this.#loop;
    this.#loop = null;
    this.#abort = null;
    this.#connected = false;
    if (loop !== null) {
      await loop.catch(() => undefined);
    }
  }

  status(): AgentEventStatus {
    return {
      connected: this.#connected,
      lastEventAt: this.#lastEventAt,
      lastError: this.#lastError,
    };
  }

  getLastError(): string | null {
    return this.#lastError;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let backoff = this.#config.event_reconnect_ms;
    while (!signal.aborted) {
      try {
        const client = await this.#getClient();
        this.#connected = true;
        this.#logger.info("Subscribed to OpenCode events");
        for await (const raw of client.event.subscribe({ signal })) {
          this.#handleRaw(raw);
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#lastError = message;
        this.#logger.warn({ err: error }, "OpenCode event stream disconnected");
      } finally {
        this.#connected = false;
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

  #handleRaw(raw: unknown): void {
    if (raw === null || typeof raw !== "object") return;
    const event = raw as RawEvent;
    if (typeof event.type !== "string") return;
    this.#lastEventAt = Date.now();
    if (event.type === "session.execution.failed") {
      const data = event.data as Record<string, unknown> | undefined;
      this.#lastError = formatStructuredError(data?.error);
    } else if (event.type === "session.execution.succeeded") {
      this.#lastError = null;
    }
    const mapped: AgentEvent = {
      type: event.type,
      sessionId: extractSessionId(event),
      data: event.data ?? null,
      receivedAt: this.#lastEventAt,
    };
    try {
      this.#onEvent(mapped);
    } catch (error) {
      this.#logger.error({ err: error, event: event.type }, "OpenCode event listener failed");
    }
  }
}
