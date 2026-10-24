import type { Logger } from "pino";
import type { RunRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionRuleset } from "../domain/permission.js";
import type { PluginConversationProfile } from "../plugins/sdk.js";
import type { AgentEvent } from "../ports/agent.js";
import { applyAgentEvent } from "./events.js";
import { type ActiveRun, type ChatState, type PendingRun, RunStoppedError } from "./types.js";

/**
 * Per-chat FIFO scheduling and active-run registry. Persistence is deliberately
 * left to the manager/executor so this module stays a pure state machine.
 */
export class ChatRunQueue {
  readonly #maxQueued: number;
  readonly #execute: (chatKey: string, active: ActiveRun) => Promise<void>;
  readonly #logger: Logger;
  readonly #states = new Map<string, ChatState>();
  readonly #activeBySession = new Map<string, ActiveRun>();
  readonly #inflight = new Set<Promise<void>>();

  constructor(options: {
    maxQueued: number;
    execute: (chatKey: string, active: ActiveRun) => Promise<void>;
    logger: Logger;
  }) {
    this.#maxQueued = options.maxQueued;
    this.#execute = options.execute;
    this.#logger = options.logger;
  }

  canAccept(chatKey: string): boolean {
    return this.#state(chatKey).pending.length < this.#maxQueued;
  }

  /** Returns true when the run had to wait behind an active run. */
  enqueue(
    record: RunRecord,
    message: IncomingMessage,
    permissions: PermissionRuleset = [],
    options: { rawText?: string; profile?: PluginConversationProfile | null } = {},
  ): boolean {
    const state = this.#state(record.chatKey);
    const queued = state.active !== null;
    state.pending.push({
      record,
      message,
      rawText: options.rawText ?? message.text,
      permissions,
      profile: options.profile ?? null,
    });
    this.#drain(record.chatKey);
    return queued;
  }

  active(chatKey: string): ActiveRun | null {
    return this.#states.get(chatKey)?.active ?? null;
  }

  pendingCount(chatKey: string): number {
    return this.#states.get(chatKey)?.pending.length ?? 0;
  }

  activeRuns(): ActiveRun[] {
    return [...this.#states.values()].flatMap((state) => (state.active ? [state.active] : []));
  }

  pendingRuns(): PendingRun[] {
    return [...this.#states.values()].flatMap((state) => state.pending);
  }

  activeCount(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.active !== null) count += 1;
    }
    return count;
  }

  queuedCount(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      count += state.pending.length;
    }
    return count;
  }

  clearPending(chatKey: string): PendingRun[] {
    const state = this.#states.get(chatKey);
    if (state === undefined) return [];
    const pending = state.pending;
    state.pending = [];
    return pending;
  }

  clearPendingAll(): void {
    for (const state of this.#states.values()) {
      state.pending = [];
    }
  }

  stopActive(chatKey: string): ActiveRun | null {
    const active = this.active(chatKey);
    if (active === null) return null;
    active.stopRequested = true;
    active.abort.abort(new RunStoppedError());
    return active;
  }

  abortAll(): ActiveRun[] {
    const active = this.activeRuns();
    for (const run of active) {
      run.stopRequested = true;
      run.abort.abort(new RunStoppedError());
    }
    return active;
  }

  bindSession(sessionId: string, active: ActiveRun): void {
    this.#activeBySession.set(sessionId, active);
  }

  unbindSession(sessionId: string): void {
    this.#activeBySession.delete(sessionId);
  }

  applyAgentEvent(event: AgentEvent): void {
    if (event.sessionId === null) return;
    const active = this.#activeBySession.get(event.sessionId);
    if (active === undefined) return;
    applyAgentEvent(active, event);
  }

  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const inflight = [...this.#inflight];
    if (inflight.length === 0) return;
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  clear(): void {
    this.#states.clear();
    this.#activeBySession.clear();
  }

  #state(chatKey: string): ChatState {
    let state = this.#states.get(chatKey);
    if (state === undefined) {
      state = { active: null, pending: [], draining: false };
      this.#states.set(chatKey, state);
    }
    return state;
  }

  #drain(chatKey: string): void {
    const state = this.#state(chatKey);
    if (state.draining || state.active !== null) return;
    const next = state.pending.shift();
    if (next === undefined) return;

    const active: ActiveRun = {
      record: { ...next.record, status: "running" },
      message: next.message,
      rawText: next.rawText,
      permissions: next.permissions,
      profile: next.profile,
      abort: new AbortController(),
      stopRequested: false,
      interrupted: false,
      agentError: null,
      partialText: "",
      usage: null,
      workspaceId: null,
      workspacePath: null,
      replyText: null,
    };
    state.active = active;
    state.draining = true;

    const promise = this.#execute(chatKey, active)
      .catch((error) => {
        this.#logger.error({ err: error, runId: active.record.id }, "Unhandled run failure");
      })
      .finally(() => {
        state.active = null;
        state.draining = false;
        this.#inflight.delete(promise);
        this.#drain(chatKey);
      });
    this.#inflight.add(promise);
  }
}
