import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { AuditTrail } from "../../observability/audit.js";
import type { AgentPort } from "../../ports/agent.js";
import type { PluginAgentCompletion, PluginAgentResult } from "../sdk.js";
import {
  describeError,
  isRecord,
  requireCapability,
  sumUtilityUsage,
  withTimeout,
} from "./convert.js";
import type { PluginInstance } from "./types.js";

const UTILITY_TIMEOUT_MS = 90_000;
const UTILITY_MIN_TIMEOUT_MS = 5_000;
const UTILITY_MAX_TIMEOUT_MS = 300_000;
const UTILITY_MAX_PENDING = 3;
const UTILITY_PROMPT_MAX_CHARS = 50_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const DENY_ALL_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" as const }];

interface NormalizedUtilityInput {
  prompt: string;
  timeoutMs: number;
  label: string;
  chatKey: string | null;
  actorQq: number | null;
}

export interface UtilityRunnerOptions {
  agent?: AgentPort;
  config: AppConfig;
  logger: Logger;
  audit: AuditTrail;
  now: () => number;
}

/**
 * Runs tool-free utility sessions for plugins.
 *
 * Work is serialized per plugin, bounded by a small pending queue and aborted
 * when the plugin is disposed or reloaded.
 */
export class UtilityRunner {
  readonly #agent: AgentPort | undefined;
  readonly #coreAgent: string;
  readonly #logger: Logger;
  readonly #audit: AuditTrail;
  readonly #now: () => number;
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #abort = new Map<string, AbortController>();
  readonly #pending = new Map<string, number>();

  constructor(options: UtilityRunnerOptions) {
    this.#agent = options.agent;
    this.#coreAgent = options.config.opencode.default_agent ?? "qq-code";
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#now = options.now;
  }

  /** Install a fresh abort controller before a plugin's setup runs. */
  reset(instanceId: string): void {
    this.#abort.set(instanceId, new AbortController());
  }

  async complete(
    instance: PluginInstance,
    input: PluginAgentCompletion,
  ): Promise<PluginAgentResult> {
    requireCapability(instance, "agent");
    if (this.#agent === undefined) {
      throw new Error("utility agent is not available in this bridge");
    }
    const request = normalizeUtilityInput(input);
    const pending = (this.#pending.get(instance.id) ?? 0) + 1;
    if (pending > UTILITY_MAX_PENDING) {
      throw new Error(
        `plugin ${instance.id} already has ${UTILITY_MAX_PENDING} utility runs pending`,
      );
    }
    this.#pending.set(instance.id, pending);

    const previous = this.#chains.get(instance.id) ?? Promise.resolve();
    const task = previous.then(
      () => this.#run(instance, request),
      () => this.#run(instance, request),
    );
    let tail: Promise<void>;
    tail = task.then(
      () => {
        this.#finishPending(instance.id, tail);
      },
      () => {
        this.#finishPending(instance.id, tail);
      },
    );
    this.#chains.set(instance.id, tail);
    return task;
  }

  /** Abort in-flight runs and wait briefly for the plugin's queue to drain. */
  async dispose(instanceId: string): Promise<void> {
    this.#abort.get(instanceId)?.abort();
    const chain = this.#chains.get(instanceId);
    if (chain !== undefined) {
      await withTimeout(
        chain,
        DISPOSE_TIMEOUT_MS,
        `utility runs of ${instanceId} during dispose`,
      ).catch(() => undefined);
    }
    this.#chains.delete(instanceId);
    this.#abort.delete(instanceId);
    this.#pending.delete(instanceId);
  }

  async #run(
    instance: PluginInstance,
    request: NormalizedUtilityInput,
  ): Promise<PluginAgentResult> {
    const agent = this.#agent;
    if (agent === undefined) throw new Error("utility agent is not available in this bridge");
    const startedAt = this.#now();
    const controller = new AbortController();
    const instanceSignal = this.#abort.get(instance.id)?.signal;
    const abortFromInstance = (): void => controller.abort();
    if (instanceSignal?.aborted === true) {
      controller.abort();
    } else {
      instanceSignal?.addEventListener("abort", abortFromInstance, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();

    let sessionId: string | null = null;
    let usage: PluginAgentResult["usage"] = null;
    let resultAgent: string | null = null;
    let resultModel: string | null = null;
    let errorMessage: string | null = null;
    try {
      const session = await agent.createSession({
        directory: instance.dataDir,
        title: `plugin:${instance.id}:${request.label}`.slice(0, 120),
        agent: this.#coreAgent,
        permissions: DENY_ALL_PERMISSIONS,
      });
      sessionId = session.id;
      await withTimeout(
        agent.prompt({ sessionId, text: request.prompt }),
        10_000,
        "utility prompt admission",
      );
      await withTimeout(
        agent.waitForCompletion(sessionId, controller.signal),
        request.timeoutMs + 1_000,
        "utility agent completion",
      );
      const messages = await withTimeout(
        agent.listMessages(sessionId, 20),
        5_000,
        "utility message read",
      );
      const latest = messages
        .filter((message) => message.type === "assistant" && message.text.trim().length > 0)
        .sort((left, right) => left.created - right.created)
        .at(-1);
      const text = latest?.text.trim();
      if (latest === undefined || text === undefined || text.length === 0) {
        throw new Error("utility agent returned no text");
      }
      usage = sumUtilityUsage(messages);
      resultAgent = latest.agent;
      resultModel = latest.model;
      return {
        text,
        sessionId,
        usage,
        agent: resultAgent,
        model: resultModel,
      };
    } catch (error) {
      errorMessage = describeError(error);
      if (sessionId !== null && controller.signal.aborted) {
        await agent.interrupt(sessionId).catch(() => undefined);
      }
      if (timedOut) {
        throw new Error(`utility agent timed out after ${request.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      instanceSignal?.removeEventListener("abort", abortFromInstance);
      if (sessionId !== null) {
        await withTimeout(agent.deleteSession(sessionId), 5_000, "utility session delete").catch(
          (error) => {
            this.#logger.warn(
              { err: error, pluginId: instance.id, sessionId },
              "Failed to delete utility session",
            );
          },
        );
      }
      this.#audit.record({
        ts: this.#now(),
        actorQq: request.actorQq,
        chatKey: request.chatKey,
        projectId: null,
        workspaceId: null,
        action: "plugin.agent",
        detail: {
          pluginId: instance.id,
          label: request.label,
          agent: resultAgent,
          model: resultModel,
          sessionId,
          ok: errorMessage === null,
          ...(errorMessage !== null ? { error: errorMessage } : {}),
          durationMs: Math.max(0, this.#now() - startedAt),
          costUsd: usage?.cost ?? 0,
          inputTokens: usage?.tokens.input ?? 0,
          outputTokens: usage?.tokens.output ?? 0,
        },
      });
    }
  }

  #finishPending(pluginId: string, tail: Promise<void>): void {
    const pending = Math.max(0, (this.#pending.get(pluginId) ?? 1) - 1);
    if (pending === 0) this.#pending.delete(pluginId);
    else this.#pending.set(pluginId, pending);
    if (this.#chains.get(pluginId) === tail) {
      this.#chains.delete(pluginId);
    }
  }
}

function normalizeUtilityInput(input: PluginAgentCompletion): NormalizedUtilityInput {
  if (!isRecord(input)) throw new Error("utility input must be an object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length === 0) throw new Error("utility prompt must not be empty");
  if (prompt.length > UTILITY_PROMPT_MAX_CHARS) {
    throw new Error(`utility prompt exceeds ${UTILITY_PROMPT_MAX_CHARS} characters`);
  }
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.min(
          UTILITY_MAX_TIMEOUT_MS,
          Math.max(UTILITY_MIN_TIMEOUT_MS, Math.floor(input.timeoutMs)),
        )
      : UTILITY_TIMEOUT_MS;
  const label =
    (typeof input.label === "string" ? input.label : "utility")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 48) || "utility";
  const chatKey =
    typeof input.chatKey === "string" && input.chatKey.trim().length > 0
      ? input.chatKey.trim().slice(0, 160)
      : null;
  const actorQq =
    typeof input.actorQq === "number" && Number.isSafeInteger(input.actorQq) && input.actorQq > 0
      ? input.actorQq
      : null;
  return { prompt, timeoutMs, label, chatKey, actorQq };
}
