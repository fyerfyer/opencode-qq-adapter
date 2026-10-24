import type { Logger } from "pino";
import { projectModels } from "../config/loader.js";
import type { AppConfig } from "../config/schema.js";
import type { ConversationRecord, RunStatus } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionRuleset } from "../domain/permission.js";
import type { WorkspaceLease } from "../domain/workspace.js";
import type { AgentPort } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import { WorkspaceLockAbortedError, type WorkspaceManager } from "../workspace/manager.js";
import { friendlyError, isSessionMissing } from "./errors.js";
import { collectResponse, toPromptFiles } from "./response.js";
import { type ActiveRun, RunStoppedError, type RunUsage } from "./types.js";

interface ProgressState {
  timer: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
  sending: Promise<void> | null;
  messageId: string | null;
  startedAt: number;
  closed: boolean;
}

export interface RunHooks {
  workspaces: WorkspaceManager;
  bindSession(sessionId: string, active: ActiveRun): void;
  unbindSession(sessionId: string): void;
  onStarted?(active: ActiveRun): void;
  onFinished?(
    active: ActiveRun,
    status: RunStatus,
    usage: RunUsage | null,
    error: string | null,
  ): void;
  onRunFailed?(active: ActiveRun, error: string): void;
}

/** Executes one queued run: session resolution, prompt, wait, response, errors. */
export class RunExecutor {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #sender: MessageSender;
  readonly #logger: Logger;
  readonly #hooks: RunHooks;

  constructor(
    config: AppConfig,
    store: StorePort,
    agent: AgentPort,
    sender: MessageSender,
    logger: Logger,
    hooks: RunHooks,
  ) {
    this.#config = config;
    this.#store = store;
    this.#agent = agent;
    this.#sender = sender;
    this.#logger = logger;
    this.#hooks = hooks;
  }

  async execute(chatKey: string, active: ActiveRun): Promise<void> {
    const { record, message } = active;
    const started = Date.now();
    let phaseStart = started;
    const phases = {
      queueWaitMs: Math.max(0, started - record.startedAt),
      lockMs: 0,
      sessionMs: 0,
      promptMs: 0,
      waitMs: 0,
      collectMs: 0,
    };
    let timeoutController: AbortController | null = null;
    let lease: WorkspaceLease | null = null;
    const progress = this.#startProgress(message);
    this.#store.runs.setStatus(record.id, "running");
    this.#hooks.onStarted?.(active);

    try {
      const project = this.#config.projects[record.projectId];
      if (project === undefined) {
        throw new Error(`Project '${record.projectId}' no longer exists in configuration`);
      }

      lease = await this.#hooks.workspaces.acquire(
        record.projectId,
        chatKey,
        record.id,
        active.abort.signal,
      );
      phases.lockMs = Date.now() - phaseStart;
      phaseStart = Date.now();
      active.workspaceId = lease.id;
      active.workspacePath = lease.path;
      record.workspaceId = lease.id;
      this.#store.runs.setWorkspace(record.id, lease.id);
      this.#store.conversations.setWorkspace(chatKey, lease.id);

      const conversation = this.#ensureConversation(
        chatKey,
        record.projectId,
        lease.id,
        message.userId,
      );
      const ensured = await this.#ensureSession(conversation, lease.path, message, active);
      const session = ensured.session;
      const updated = ensured.conversation;
      record.sessionId = session.id;
      this.#store.runs.setSession(record.id, session.id);
      this.#hooks.bindSession(session.id, active);

      if (active.permissions.length > 0) {
        await this.#agent.updatePermissions(session.id, active.permissions);
      }
      phases.sessionMs = Date.now() - phaseStart;
      phaseStart = Date.now();
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
        const recreated = await this.#createSession(
          updated,
          lease.path,
          message,
          active.permissions,
        );
        this.#hooks.unbindSession(session.id);
        record.sessionId = recreated.id;
        this.#store.runs.setSession(record.id, recreated.id);
        this.#hooks.bindSession(recreated.id, active);
        receipt = await this.#agent.prompt({
          sessionId: recreated.id,
          text: message.text,
          ...(message.images.length > 0 ? { files: message.images.flatMap(toPromptFiles) } : {}),
        });
      }
      phases.promptMs = Date.now() - phaseStart;
      phaseStart = Date.now();
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
      phases.waitMs = Date.now() - phaseStart;
      phaseStart = Date.now();

      if (active.stopRequested || active.interrupted) {
        throw new RunStoppedError();
      }
      if (active.agentError !== null) {
        throw new Error(active.agentError);
      }

      const result = await collectResponse(
        this.#agent,
        record.sessionId ?? session.id,
        receipt,
        active,
      );
      phases.collectMs = Date.now() - phaseStart;
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
      this.#hooks.onFinished?.(active, "completed", usage, null);
      this.#store.conversations.setSession(chatKey, record.sessionId, session.agent, session.model);
      this.#logger.info(
        {
          runId: record.id,
          chatKey,
          sessionId: record.sessionId,
          durationMs: Date.now() - started,
          phases,
          cost: usage?.cost,
        },
        "Run completed",
      );
    } catch (error) {
      if (
        active.stopRequested ||
        error instanceof RunStoppedError ||
        error instanceof WorkspaceLockAbortedError
      ) {
        this.#finish(record.id, "interrupted", { stopReason: "user" });
        this.#hooks.onFinished?.(active, "interrupted", active.usage, null);
        this.#logger.info({ runId: record.id, chatKey }, "Run interrupted by user");
        return;
      }
      const friendly = friendlyError(error);
      this.#finish(record.id, "failed", { error: friendly });
      this.#hooks.onFinished?.(active, "failed", active.usage, friendly);
      this.#hooks.onRunFailed?.(active, friendly);
      this.#logger.error(
        { err: error, runId: record.id, chatKey, phases, durationMs: Date.now() - started },
        "Run failed",
      );
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
        this.#hooks.unbindSession(record.sessionId);
      }
      if (lease !== null) {
        this.#hooks.workspaces.release(lease);
      }
      await this.#cleanupProgress(message, progress);
    }
  }

  #startProgress(message: IncomingMessage): ProgressState {
    const state: ProgressState = {
      timer: null,
      interval: null,
      sending: null,
      messageId: null,
      startedAt: Date.now(),
      closed: false,
    };
    if (!this.#config.qq.progress_ack) return state;

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#sendProgress(message, state, true);
      const interval = this.#config.qq.progress_interval_ms;
      if (interval > 0) {
        state.interval = setInterval(() => {
          void this.#sendProgress(message, state, false);
        }, interval);
        state.interval.unref?.();
      }
    }, this.#config.qq.progress_delay_ms);
    state.timer.unref?.();
    return state;
  }

  async #sendProgress(
    message: IncomingMessage,
    state: ProgressState,
    initial: boolean,
  ): Promise<void> {
    if (state.closed || state.sending !== null) return;
    const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
    state.sending = (async () => {
      if (!initial && state.messageId !== null) {
        await this.#sender.delete(message.chat, state.messageId);
        state.messageId = null;
      }
      const text = initial ? "⏳ 正在处理…" : `⏳ 仍在处理…（已 ${elapsed} 秒）`;
      const result = initial
        ? await this.#sender.reply(message.chat, message.id, text)
        : await this.#sender.send(message.chat, text, { mention: false });
      state.messageId =
        result.messageId !== null && result.messageId.length > 0 ? result.messageId : null;
    })()
      .catch((error) => {
        this.#logger.debug({ err: error, chatKey: message.chat.chatKey }, "Progress ack failed");
      })
      .finally(() => {
        state.sending = null;
      });
    await state.sending;
  }

  async #cleanupProgress(message: IncomingMessage, state: ProgressState): Promise<void> {
    state.closed = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.interval !== null) {
      clearInterval(state.interval);
      state.interval = null;
    }
    if (state.sending !== null) {
      await state.sending.catch(() => undefined);
    }
    if (state.messageId !== null) {
      await this.#sender.delete(message.chat, state.messageId);
      state.messageId = null;
    }
  }

  #ensureConversation(
    chatKey: string,
    projectId: string,
    workspaceId: string,
    actorQq: number,
  ): ConversationRecord {
    const existing = this.#store.conversations.get(chatKey);
    const now = Date.now();
    if (existing !== null && existing.projectId === projectId) {
      if (existing.actorQq !== actorQq || existing.workspaceId !== workspaceId) {
        this.#store.conversations.upsert({
          ...existing,
          workspaceId,
          actorQq,
          lastActiveAt: now,
        });
      }
      return { ...existing, workspaceId, actorQq, lastActiveAt: now };
    }
    const record: ConversationRecord = {
      chatKey,
      projectId,
      workspaceId,
      sessionId: null,
      actorQq,
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
    const session = await this.#createSession(conversation, directory, message, active.permissions);
    return { session, conversation: { ...conversation, sessionId: session.id } };
  }

  async #createSession(
    conversation: ConversationRecord,
    directory: string,
    message: IncomingMessage,
    permissions: PermissionRuleset,
  ): Promise<Awaited<ReturnType<AgentPort["createSession"]>>> {
    const project = this.#config.projects[conversation.projectId];
    if (project === undefined) {
      throw new Error(`Project '${conversation.projectId}' no longer exists`);
    }
    const resolved = projectModels(this.#config, project);
    const agent = conversation.agent ?? resolved.agent;
    const model = conversation.model ?? resolved.model;
    const session = await this.#agent.createSession({
      directory,
      title: `${conversation.projectId} · QQ ${message.userId}`,
      agent,
      model,
      ...(permissions.length > 0 ? { permissions } : {}),
    });
    this.#store.conversations.setSession(conversation.chatKey, session.id, agent, model);
    return session;
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
}
