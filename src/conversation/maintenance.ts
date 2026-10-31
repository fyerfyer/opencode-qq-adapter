import type { Logger } from "pino";
import type { MaintenanceGate } from "./types.js";

export interface MaintenanceCounts {
  activeRuns: number;
  queuedRuns: number;
}

/**
 * Blocks new work while configuration or plugin instances are being replaced.
 * The gate is only granted when the queue and in-flight submissions are idle,
 * so a reload can never tear down a running location.
 */
export class ConversationMaintenance {
  readonly #counts: () => MaintenanceCounts;
  readonly #logger: Logger;
  readonly #idleListeners = new Set<() => void>();
  #active = false;
  #pendingSubmissions = 0;

  constructor(options: { counts: () => MaintenanceCounts; logger: Logger }) {
    this.#counts = options.counts;
    this.#logger = options.logger;
  }

  get active(): boolean {
    return this.#active;
  }

  get pendingSubmissions(): number {
    return this.#pendingSubmissions;
  }

  /** Count a prompt while it is resolving plugin hooks and about to queue. */
  async trackSubmission<T>(task: () => Promise<T>): Promise<T> {
    this.#pendingSubmissions += 1;
    try {
      return await task();
    } finally {
      this.#pendingSubmissions -= 1;
    }
  }

  begin(): MaintenanceGate {
    const { activeRuns, queuedRuns } = this.#counts();
    if (this.#active) {
      return {
        ok: false,
        reason: "配置或插件重载已在进行中。",
        activeRuns,
        queuedRuns,
        pendingSubmissions: this.#pendingSubmissions,
      };
    }
    if (activeRuns > 0 || queuedRuns > 0 || this.#pendingSubmissions > 0) {
      return {
        ok: false,
        reason: "还有任务正在运行、排队或准备提交，暂时不能重载配置或插件。",
        activeRuns,
        queuedRuns,
        pendingSubmissions: this.#pendingSubmissions,
      };
    }
    this.#active = true;
    return { ok: true, activeRuns: 0, queuedRuns: 0, pendingSubmissions: 0 };
  }

  end(): void {
    this.#active = false;
  }

  /** Called after the last active and queued run has finished. */
  onIdle(listener: () => void): () => void {
    this.#idleListeners.add(listener);
    return () => this.#idleListeners.delete(listener);
  }

  emitIdle(): void {
    for (const listener of this.#idleListeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.error({ err: error }, "Conversation idle listener failed");
      }
    }
  }
}
