import type { Logger } from "pino";
import { ulid } from "ulid";
import type { AppConfig } from "../config/schema.js";
import type { ConversationRecord, RunRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { AgentPort } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import { RunExecutor } from "./executor.js";
import { ChatRunQueue } from "./queue.js";
import type { ConversationStatus, SubmitResult } from "./types.js";

export type { ConversationStatus, SubmitResult } from "./types.js";
export { RunStoppedError } from "./types.js";

/** Public conversation facade: submission, stop, project/session state and status. */
export class ConversationManager {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #sender: MessageSender;
  readonly #logger: Logger;
  readonly #queue: ChatRunQueue;
  readonly #executor: RunExecutor;
  readonly #unsubscribe: () => void;

  constructor(
    config: AppConfig,
    store: StorePort,
    agent: AgentPort,
    sender: MessageSender,
    logger: Logger,
  ) {
    this.#config = config;
    this.#store = store;
    this.#agent = agent;
    this.#sender = sender;
    this.#logger = logger;
    this.#queue = new ChatRunQueue({
      maxQueued: config.security.max_queued_prompts,
      logger,
      execute: (chatKey, active) => this.#executor.execute(chatKey, active),
    });
    this.#executor = new RunExecutor(config, store, agent, sender, logger, {
      bindSession: (sessionId, active) => this.#queue.bindSession(sessionId, active),
      unbindSession: (sessionId) => this.#queue.unbindSession(sessionId),
    });
    this.#unsubscribe = agent.subscribe((event) => this.#queue.applyAgentEvent(event));
    const recovered = store.runs.recoverActive(Date.now());
    if (recovered > 0) {
      this.#logger.warn({ recovered }, "Marked stale runs as interrupted after restart");
    }
  }

  getConversation(chatKey: string): ConversationRecord | null {
    return this.#store.conversations.get(chatKey);
  }

  async submit(message: IncomingMessage, projectId: string): Promise<SubmitResult> {
    const now = Date.now();
    const run: RunRecord = {
      id: ulid(now),
      chatKey: message.chat.chatKey,
      projectId,
      sessionId: null,
      status: "queued",
      startedAt: now,
      finishedAt: null,
      stopReason: null,
      error: null,
      usageJson: null,
    };

    if (!this.#queue.canAccept(message.chat.chatKey)) {
      this.#store.runs.create({ ...run, status: "rejected", finishedAt: now });
      await this.#sender.reply(
        message.chat,
        message.id,
        `当前任务队列已满（最多 ${this.#config.security.max_queued_prompts} 条）。请等待完成或发送 !stop 清空队列。`,
      );
      return { accepted: false, runId: run.id, queued: false };
    }

    this.#store.runs.create(run);
    const queued = this.#queue.enqueue(run, message);
    return { accepted: true, runId: run.id, queued };
  }

  async stop(chatKey: string): Promise<{ stopped: boolean; queuedCleared: number }> {
    const pending = this.#queue.clearPending(chatKey);
    const now = Date.now();
    for (const item of pending) {
      item.record.status = "cancelled";
      this.#store.runs.finish(item.record.id, {
        status: "cancelled",
        finishedAt: now,
        stopReason: "stop_command",
      });
    }

    const active = this.#queue.stopActive(chatKey);
    if (active === null) {
      return { stopped: false, queuedCleared: pending.length };
    }

    if (active.record.sessionId !== null) {
      try {
        await this.#agent.interrupt(active.record.sessionId);
      } catch (error) {
        this.#logger.warn(
          { err: error, runId: active.record.id },
          "Failed to interrupt OpenCode session",
        );
      }
    }
    return { stopped: true, queuedCleared: pending.length };
  }

  setProject(chatKey: string, projectId: string, userId: number): { ok: boolean; reason?: string } {
    if (this.#queue.active(chatKey) !== null) {
      return { ok: false, reason: "当前有任务运行中，请先发送 !stop。" };
    }
    if (this.#queue.pendingCount(chatKey) > 0) {
      return { ok: false, reason: "当前还有排队任务，请先发送 !stop。" };
    }
    const existing = this.#store.conversations.get(chatKey);
    const now = Date.now();
    if (existing?.projectId === projectId) {
      return { ok: true };
    }
    this.#store.conversations.upsert({
      chatKey,
      projectId,
      sessionId: null,
      agent: null,
      model: null,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
    });
    this.#logger.info({ chatKey, userId, projectId }, "Conversation project changed");
    return { ok: true };
  }

  resetSession(chatKey: string): { ok: boolean; reason?: string } {
    if (this.#queue.active(chatKey) !== null) {
      return { ok: false, reason: "当前有任务运行中，请先发送 !stop。" };
    }
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null) {
      return { ok: false, reason: "还没有会话。请先发送 !use <项目>。" };
    }
    this.#store.conversations.setSession(chatKey, null, null, null);
    this.#logger.info({ chatKey }, "Conversation session cleared");
    return { ok: true };
  }

  status(chatKey: string): ConversationStatus {
    const active = this.#queue.active(chatKey);
    return {
      conversation: this.#store.conversations.get(chatKey),
      activeRun: active?.record ?? null,
      queued: this.#queue.pendingCount(chatKey),
      recentRuns: this.#store.runs.listRecent(chatKey, 3),
    };
  }

  activeRuns(): number {
    return this.#queue.activeCount();
  }

  queuedRuns(): number {
    return this.#queue.queuedCount();
  }

  async shutdown(): Promise<void> {
    this.#unsubscribe();
    const pending = this.#queue.pendingRuns();
    const now = Date.now();
    for (const item of pending) {
      this.#store.runs.finish(item.record.id, {
        status: "interrupted",
        finishedAt: now,
        stopReason: "bridge_shutdown",
      });
    }
    this.#queue.clearPendingAll();

    for (const active of this.#queue.abortAll()) {
      if (active.record.sessionId !== null) {
        void this.#agent.interrupt(active.record.sessionId).catch(() => undefined);
      }
    }
    await this.#queue.waitForIdle(5000);
    this.#queue.clear();
  }
}
