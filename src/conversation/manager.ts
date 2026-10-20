import type { Logger } from "pino";
import { ulid } from "ulid";
import { projectModels } from "../config/loader.js";
import type { AppConfig } from "../config/schema.js";
import type { ConversationRecord, RunRecord, RunStatus } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import { AgentUnavailableError, AgentVersionMismatchError } from "../opencode/adapter.js";
import type { AgentEvent, AgentMessage, AgentPort } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";

export class RunStoppedError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "RunStoppedError";
  }
}

interface ActiveRun {
  record: RunRecord;
  message: IncomingMessage;
  abort: AbortController;
  stopRequested: boolean;
  interrupted: boolean;
  agentError: string | null;
  partialText: string;
  receiptCreated: number | null;
  usage: {
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
    };
  } | null;
}

interface PendingRun {
  record: RunRecord;
  message: IncomingMessage;
}

interface ChatState {
  active: ActiveRun | null;
  pending: PendingRun[];
  draining: boolean;
}

export interface SubmitResult {
  accepted: boolean;
  runId: string;
  queued: boolean;
}

export interface ConversationStatus {
  conversation: ConversationRecord | null;
  activeRun: RunRecord | null;
  queued: number;
  recentRuns: RunRecord[];
}

export class ConversationManager {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #sender: MessageSender;
  readonly #logger: Logger;
  readonly #states = new Map<string, ChatState>();
  readonly #activeBySession = new Map<string, ActiveRun>();
  readonly #inflight = new Set<Promise<void>>();
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
    this.#unsubscribe = agent.subscribe((event) => this.#onAgentEvent(event));
    const recovered = store.runs.recoverActive(Date.now());
    if (recovered > 0) {
      this.#logger.warn({ recovered }, "Marked stale runs as interrupted after restart");
    }
  }

  getConversation(chatKey: string): ConversationRecord | null {
    return this.#store.conversations.get(chatKey);
  }

  async submit(message: IncomingMessage, projectId: string): Promise<SubmitResult> {
    const state = this.#state(message.chat.chatKey);
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

    if (state.pending.length >= this.#config.security.max_queued_prompts) {
      this.#store.runs.create({ ...run, status: "rejected", finishedAt: now });
      await this.#sender.reply(
        message.chat,
        message.id,
        `当前任务队列已满（最多 ${this.#config.security.max_queued_prompts} 条）。请等待完成或发送 !stop 清空队列。`,
      );
      return { accepted: false, runId: run.id, queued: false };
    }

    this.#store.runs.create(run);
    const queued = state.active !== null;
    state.pending.push({ record: run, message });
    this.#drain(message.chat.chatKey);
    return { accepted: true, runId: run.id, queued };
  }

  async stop(chatKey: string): Promise<{ stopped: boolean; queuedCleared: number }> {
    const state = this.#states.get(chatKey);
    if (state === undefined) {
      return { stopped: false, queuedCleared: 0 };
    }

    const queuedCleared = state.pending.length;
    const now = Date.now();
    for (const pending of state.pending) {
      pending.record.status = "cancelled";
      this.#store.runs.finish(pending.record.id, {
        status: "cancelled",
        finishedAt: now,
        stopReason: "stop_command",
      });
    }
    state.pending.length = 0;

    const active = state.active;
    if (active === null) {
      return { stopped: false, queuedCleared };
    }

    active.stopRequested = true;
    active.abort.abort(new RunStoppedError());
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
    return { stopped: true, queuedCleared };
  }

  setProject(chatKey: string, projectId: string, userId: number): { ok: boolean; reason?: string } {
    const state = this.#states.get(chatKey);
    if (state !== undefined && state.active !== null) {
      return { ok: false, reason: "当前有任务运行中，请先发送 !stop。" };
    }
    if ((state?.pending.length ?? 0) > 0) {
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
    const state = this.#states.get(chatKey);
    if (state !== undefined && state.active !== null) {
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
    const state = this.#states.get(chatKey);
    return {
      conversation: this.#store.conversations.get(chatKey),
      activeRun: state?.active?.record ?? null,
      queued: state?.pending.length ?? 0,
      recentRuns: this.#store.runs.listRecent(chatKey, 3),
    };
  }

  activeRuns(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.active !== null) count += 1;
    }
    return count;
  }

  queuedRuns(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      count += state.pending.length;
    }
    return count;
  }

  async shutdown(): Promise<void> {
    this.#unsubscribe();
    for (const state of this.#states.values()) {
      for (const pending of state.pending) {
        this.#store.runs.finish(pending.record.id, {
          status: "interrupted",
          finishedAt: Date.now(),
          stopReason: "bridge_shutdown",
        });
      }
      state.pending.length = 0;
      if (state.active !== null) {
        state.active.stopRequested = true;
        state.active.abort.abort(new RunStoppedError());
        if (state.active.record.sessionId !== null) {
          void this.#agent.interrupt(state.active.record.sessionId).catch(() => undefined);
        }
      }
    }
    const inflight = [...this.#inflight];
    if (inflight.length > 0) {
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
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
      abort: new AbortController(),
      stopRequested: false,
      interrupted: false,
      agentError: null,
      partialText: "",
      receiptCreated: null,
      usage: null,
    };
    state.active = active;
    state.draining = true;
    this.#store.runs.setStatus(active.record.id, "running");

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

  async #execute(chatKey: string, active: ActiveRun): Promise<void> {
    const { record, message } = active;
    const started = Date.now();
    let timeoutController: AbortController | null = null;

    try {
      const project = this.#config.projects[record.projectId];
      if (project === undefined) {
        throw new Error(`Project '${record.projectId}' no longer exists in configuration`);
      }

      const conversation = this.#ensureConversation(chatKey, record.projectId);
      const ensured = await this.#ensureSession(conversation, project.path, message, active);
      const session = ensured.session;
      const updated = ensured.conversation;
      record.sessionId = session.id;
      this.#store.runs.setSession(record.id, session.id);
      this.#activeBySession.set(session.id, active);
      active.receiptCreated = Date.now();

      if (active.stopRequested) throw new RunStoppedError();

      let receipt: { messageId: string; created: number };
      try {
        receipt = await this.#agent.prompt({
          sessionId: session.id,
          text: message.text,
          ...(message.images.length > 0 ? { files: message.images.flatMap(toPromptFiles) } : {}),
        });
      } catch (error) {
        if (!isSessionMissing(error)) throw error;
        this.#logger.warn(
          { err: error, sessionId: session.id },
          "Session vanished before prompt; recreating",
        );
        const recreated = await this.#createSession(updated, project.path, message);
        record.sessionId = recreated.id;
        this.#store.runs.setSession(record.id, recreated.id);
        this.#activeBySession.set(recreated.id, active);
        receipt = await this.#agent.prompt({
          sessionId: recreated.id,
          text: message.text,
        });
      }
      active.receiptCreated = receipt.created;
      if (active.stopRequested) throw new RunStoppedError();

      timeoutController = new AbortController();
      const timeoutMs = this.#config.opencode.prompt_timeout_ms;
      const timer = setTimeout(() => {
        timeoutController?.abort(new Error(`prompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const signal = AbortSignal.any([active.abort.signal, timeoutController.signal]);
      try {
        await this.#agent.waitForCompletion(record.sessionId ?? session.id, signal);
      } catch (error) {
        if (active.stopRequested) throw new RunStoppedError();
        if (timeoutController.signal.aborted) {
          await this.#agent.interrupt(record.sessionId ?? session.id).catch(() => undefined);
          throw new Error(`OpenCode 处理超时（${Math.round(timeoutMs / 1000)} 秒），已请求中断。`);
        }
        this.#logger.warn(
          { err: error, runId: record.id },
          "Wait for OpenCode completion failed; trying message history",
        );
      } finally {
        clearTimeout(timer);
      }

      if (active.stopRequested || active.interrupted) {
        throw new RunStoppedError();
      }
      if (active.agentError !== null) {
        throw new Error(active.agentError);
      }

      const result = await this.#collectResponse(record.sessionId ?? session.id, receipt, active);
      if (result.error !== null) {
        throw new Error(result.error);
      }
      const finalText =
        result.text.trim().length > 0
          ? result.text
          : "任务已完成，但 OpenCode 没有返回可发送的文本输出。";

      await this.#sender.reply(message.chat, message.id, finalText);
      const usage = result.usage ?? active.usage;
      this.#finish(record.id, "completed", {
        usageJson: usage ? JSON.stringify(usage) : undefined,
      });
      this.#store.conversations.setSession(chatKey, record.sessionId, session.agent, session.model);
      this.#logger.info(
        {
          runId: record.id,
          chatKey,
          sessionId: record.sessionId,
          durationMs: Date.now() - started,
          cost: usage?.cost,
        },
        "Run completed",
      );
    } catch (error) {
      if (active.stopRequested || error instanceof RunStoppedError) {
        this.#finish(record.id, "interrupted", { stopReason: "user" });
        this.#logger.info({ runId: record.id, chatKey }, "Run interrupted by user");
        return;
      }
      const friendly = friendlyError(error);
      this.#finish(record.id, "failed", { error: friendly });
      this.#logger.error({ err: error, runId: record.id, chatKey }, "Run failed");
      try {
        await this.#sender.reply(message.chat, message.id, `处理失败：${friendly}`);
      } catch (sendError) {
        this.#logger.error(
          { err: sendError, runId: record.id },
          "Failed to report run error to QQ",
        );
      }
    } finally {
      if (record.sessionId !== null) {
        this.#activeBySession.delete(record.sessionId);
      }
    }
  }

  #ensureConversation(chatKey: string, projectId: string): ConversationRecord {
    const existing = this.#store.conversations.get(chatKey);
    const now = Date.now();
    if (existing !== null && existing.projectId === projectId) {
      return existing;
    }
    const record: ConversationRecord = {
      chatKey,
      projectId,
      sessionId: null,
      agent: null,
      model: null,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
    };
    this.#store.conversations.upsert(record);
    return record;
  }

  async #ensureSession(
    conversation: ConversationRecord,
    directory: string,
    message: IncomingMessage,
    active: ActiveRun,
  ): Promise<{
    session: Awaited<ReturnType<AgentPort["createSession"]>>;
    conversation: ConversationRecord;
  }> {
    if (conversation.sessionId !== null) {
      try {
        const existing = await this.#agent.getSession(conversation.sessionId);
        if (existing !== null) {
          return { session: existing, conversation };
        }
      } catch (error) {
        if (!isSessionMissing(error)) throw error;
      }
      if (!active.stopRequested) {
        await this.#sender.reply(
          message.chat,
          message.id,
          "原 OpenCode 会话已不存在，已为你创建新会话。",
        );
      }
    }
    const session = await this.#createSession(conversation, directory, message);
    return { session, conversation: { ...conversation, sessionId: session.id } };
  }

  async #createSession(
    conversation: ConversationRecord,
    directory: string,
    message: IncomingMessage,
  ): Promise<Awaited<ReturnType<AgentPort["createSession"]>>> {
    const project = this.#config.projects[conversation.projectId];
    if (project === undefined) {
      throw new Error(`Project '${conversation.projectId}' no longer exists`);
    }
    const resolved = projectModels(this.#config, project);
    const session = await this.#agent.createSession({
      directory,
      title: `${conversation.projectId} · QQ ${message.userId}`,
      agent: resolved.agent,
      model: resolved.model,
    });
    this.#store.conversations.setSession(
      conversation.chatKey,
      session.id,
      resolved.agent,
      resolved.model,
    );
    return session;
  }

  async #collectResponse(
    sessionId: string,
    receipt: { messageId: string; created: number },
    active: ActiveRun,
  ): Promise<{
    text: string;
    error: string | null;
    usage: {
      cost: number;
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
      };
    } | null;
  }> {
    const messages = await this.#agent.listMessages(sessionId, 100);
    const userIndex = messages.findIndex(
      (entry) => entry.type === "user" && entry.id === receipt.messageId,
    );
    const relevant =
      userIndex >= 0
        ? messages.slice(0, userIndex)
        : messages.filter((entry) => entry.created >= receipt.created);
    const assistant = relevant.filter((entry) => entry.type === "assistant").reverse();
    if (assistant.length === 0) {
      return { text: active.partialText, error: null, usage: active.usage };
    }
    const texts = assistant.map((entry) => entry.text.trim()).filter((entry) => entry.length > 0);
    const firstError = assistant.find((entry) => entry.error !== null)?.error ?? null;
    const usage = sumUsage(assistant);
    return {
      text: texts.join("\n\n"),
      error: firstError,
      usage: usage ?? active.usage,
    };
  }

  #finish(
    runId: string,
    status: RunStatus,
    extras: { stopReason?: string; error?: string; usageJson?: string } = {},
  ): void {
    this.#store.runs.finish(runId, {
      status,
      finishedAt: Date.now(),
      ...extras,
    });
  }

  #onAgentEvent(event: AgentEvent): void {
    if (event.sessionId === null) return;
    const active = this.#activeBySession.get(event.sessionId);
    if (active === undefined) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "session.execution.failed": {
        const error = data.error;
        active.agentError = formatEventError(error);
        break;
      }
      case "session.execution.interrupted":
        active.interrupted = true;
        break;
      case "session.text.delta": {
        if (typeof data.delta === "string" && active.partialText.length < 4000) {
          active.partialText += data.delta;
        }
        break;
      }
      case "session.usage.updated": {
        if (typeof data.cost === "number") {
          active.usage = {
            cost: data.cost,
            tokens: parseTokens(data.tokens),
          };
        }
        break;
      }
      default:
        break;
    }
  }
}

function parseTokens(value: unknown): {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
} {
  if (value === null || typeof value !== "object") {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const token = value as Record<string, unknown>;
  const cache = (token.cache ?? {}) as Record<string, unknown>;
  return {
    input: numberOrZero(token.input),
    output: numberOrZero(token.output),
    reasoning: numberOrZero(token.reasoning),
    cacheRead: numberOrZero(cache.read),
    cacheWrite: numberOrZero(cache.write),
  };
}

function sumUsage(messages: AgentMessage[]): {
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
} | null {
  let cost = 0;
  let hasCost = false;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let hasTokens = false;
  for (const message of messages) {
    if (message.cost !== null) {
      cost += message.cost;
      hasCost = true;
    }
    if (message.tokens !== null) {
      hasTokens = true;
      tokens.input += message.tokens.input;
      tokens.output += message.tokens.output;
      tokens.reasoning += message.tokens.reasoning;
      tokens.cacheRead += message.tokens.cacheRead;
      tokens.cacheWrite += message.tokens.cacheWrite;
    }
  }
  if (!hasCost && !hasTokens) return null;
  return { cost, tokens };
}

function formatEventError(value: unknown): string {
  if (value === null || typeof value !== "object") return "OpenCode execution failed";
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "error";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
  return `${type}: ${message}`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isSessionMissing(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const cause = (error as { cause?: { status?: number } }).cause;
  if (cause?.status === 404) return true;
  const message = error instanceof Error ? error.message : "";
  return /session.*(not.?found|missing)|not.?found.*session/i.test(message);
}

function toPromptFiles(image: IncomingMessage["images"][number]): Array<{
  uri: string;
  name?: string;
  description?: string;
}> {
  const file = image.file;
  if (file?.startsWith("file://")) {
    return [{ uri: file, name: "image", description: image.summary }];
  }
  // OpenCode v2 prompts only accept local file URIs. Downloading remote QQ
  // images is part of M4; ignoring the URL here keeps prompt handling safe.
  return [];
}

function friendlyError(error: unknown): string {
  if (error instanceof AgentUnavailableError) {
    return `OpenCode 服务不可用。${error.message}`;
  }
  if (error instanceof AgentVersionMismatchError) {
    return `OpenCode 版本不匹配：${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
