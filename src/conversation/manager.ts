import type { Logger } from "pino";
import { ulid } from "ulid";
import type { AppConfig } from "../config/schema.js";
import type { ConversationRecord, RunRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionRuleset } from "../domain/permission.js";
import type { AuditTrail } from "../observability/audit.js";
import type { PluginHost } from "../plugins/host.js";
import type { PluginConversationProfile } from "../plugins/sdk.js";
import type { QuotaService } from "../policy/quota.js";
import type { AgentPort, AgentSession } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import type { WorkspaceDiff, WorkspaceManager, WorkspaceStatus } from "../workspace/manager.js";
import { RunExecutor } from "./executor.js";
import { ChatRunQueue } from "./queue.js";
import type { ActiveRun, ConversationStatus, MaintenanceGate, SubmitResult } from "./types.js";

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
  readonly #quota: QuotaService | undefined;
  readonly #audit: AuditTrail | undefined;
  readonly #workspaces: WorkspaceManager;
  readonly #plugins: PluginHost | undefined;
  readonly #recoveredRuns: number;
  readonly #idleListeners = new Set<() => void>();
  #maintenance = false;

  constructor(
    config: AppConfig,
    store: StorePort,
    agent: AgentPort,
    sender: MessageSender,
    logger: Logger,
    options: {
      quota?: QuotaService;
      audit?: AuditTrail;
      workspaces: WorkspaceManager;
      plugins?: PluginHost;
      onRunFailed?: (active: ActiveRun, error: string) => void;
    },
  ) {
    this.#config = config;
    this.#store = store;
    this.#agent = agent;
    this.#sender = sender;
    this.#logger = logger;
    this.#quota = options.quota;
    this.#audit = options.audit;
    this.#workspaces = options.workspaces;
    this.#plugins = options.plugins;
    this.#queue = new ChatRunQueue({
      maxQueued: config.security.max_queued_prompts,
      logger,
      execute: (chatKey, active) => this.#executor.execute(chatKey, active),
      onIdle: () => this.#emitIdle(),
    });
    this.#executor = new RunExecutor(config, store, agent, sender, logger, {
      workspaces: this.#workspaces,
      bindSession: (sessionId, active) => this.#queue.bindSession(sessionId, active),
      unbindSession: (sessionId) => this.#queue.unbindSession(sessionId),
      formatReply: async (active, text) => (await this.#plugins?.formatReply(active, text)) ?? null,
      onStarted: (active) => {
        this.#audit?.record({
          ts: Date.now(),
          actorQq: active.record.actorQq,
          chatKey: active.record.chatKey,
          projectId: active.record.projectId,
          workspaceId: active.workspaceId,
          action: "run.started",
          detail: { runId: active.record.id, sessionId: active.record.sessionId },
        });
      },
      onSession: (active, session) => {
        this.#audit?.record({
          ts: Date.now(),
          actorQq: active.record.actorQq,
          chatKey: active.record.chatKey,
          projectId: active.record.projectId,
          workspaceId: active.workspaceId,
          action: "run.session",
          detail: {
            runId: active.record.id,
            sessionId: session.id,
            agent: session.agent,
            model: session.model,
          },
        });
      },
      onRunFailed: (active, error) => options.onRunFailed?.(active, error),
      onFinished: (active, status, usage, error, metadata) => {
        if (usage !== null && active.record.actorQq !== null) {
          this.#quota?.recordRunUsage(active.record.actorQq, active.record.projectId, {
            inputTokens: usage.tokens.input,
            outputTokens: usage.tokens.output,
            costUsd: usage.cost,
          });
        }
        void this.#plugins?.afterRun(active, status, usage, error).catch((hookError) => {
          this.#logger.warn({ err: hookError, runId: active.record.id }, "Plugin afterRun failed");
        });
        this.#audit?.record({
          ts: Date.now(),
          actorQq: active.record.actorQq,
          chatKey: active.record.chatKey,
          projectId: active.record.projectId,
          workspaceId: active.workspaceId,
          action: "run.finished",
          detail: {
            runId: active.record.id,
            status,
            agent: metadata?.agent ?? null,
            model: metadata?.model ?? null,
            sessionId: active.record.sessionId,
            costUsd: usage?.cost ?? 0,
            inputTokens: usage?.tokens.input ?? 0,
            outputTokens: usage?.tokens.output ?? 0,
            reasoningTokens: usage?.tokens.reasoning ?? 0,
            cacheReadTokens: usage?.tokens.cacheRead ?? 0,
            cacheWriteTokens: usage?.tokens.cacheWrite ?? 0,
            durationMs: Date.now() - active.record.startedAt,
          },
        });
      },
    });
    this.#unsubscribe = agent.subscribe((event) => this.#queue.applyAgentEvent(event));
    const recovered = store.runs.recoverActive(Date.now());
    this.#recoveredRuns = recovered;
    if (recovered > 0) {
      this.#logger.warn({ recovered }, "Marked stale runs as interrupted after restart");
      this.#audit?.record({
        ts: Date.now(),
        actorQq: null,
        chatKey: null,
        projectId: null,
        workspaceId: null,
        action: "runs.recovered",
        detail: { count: recovered },
      });
    }
  }

  getConversation(chatKey: string): ConversationRecord | null {
    return this.#store.conversations.get(chatKey);
  }

  get recoveredRuns(): number {
    return this.#recoveredRuns;
  }

  async submit(
    inputMessage: IncomingMessage,
    projectId: string,
    permissions: PermissionRuleset = [],
  ): Promise<SubmitResult> {
    if (this.#maintenance) {
      return {
        accepted: false,
        runId: "",
        queued: false,
        reason: "正在重载 OpenCode 配置，请稍后重试。",
      };
    }
    let message = inputMessage;
    let profile: PluginConversationProfile | null = null;
    if (this.#plugins !== undefined) {
      const resolved = await this.#plugins.resolveProfile(inputMessage, projectId);
      profile = resolved.profile;
      const injected = await this.#plugins.beforePrompt(inputMessage, projectId, profile);
      if (injected.modified) {
        message = { ...inputMessage, text: injected.text };
        this.#logger.debug(
          { chatKey: message.chat.chatKey, plugins: injected.plugins },
          "Plugin prompt context injected",
        );
      }
    }

    const now = Date.now();
    if (message.text.length > this.#config.security.max_prompt_chars) {
      const rejected: RunRecord = {
        id: ulid(now),
        chatKey: message.chat.chatKey,
        projectId,
        workspaceId: null,
        sessionId: null,
        actorQq: message.userId,
        status: "rejected",
        startedAt: now,
        finishedAt: now,
        stopReason: "prompt_too_long_after_plugin",
        error: null,
        usageJson: null,
      };
      this.#store.runs.create(rejected);
      this.#audit?.record({
        ts: now,
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId,
        workspaceId: null,
        action: "run.rejected",
        detail: { runId: rejected.id, reason: "prompt_too_long_after_plugin" },
      });
      await this.#sender.reply(
        message.chat,
        message.id,
        `插件注入上下文后消息过长（${message.text.length} 字），上限为 ${this.#config.security.max_prompt_chars} 字。`,
      );
      return { accepted: false, runId: rejected.id, queued: false };
    }

    const run: RunRecord = {
      id: ulid(now),
      chatKey: message.chat.chatKey,
      projectId,
      workspaceId: null,
      sessionId: null,
      actorQq: message.userId,
      status: "queued",
      startedAt: now,
      finishedAt: null,
      stopReason: null,
      error: null,
      usageJson: null,
    };

    if (!this.#queue.canAccept(message.chat.chatKey)) {
      this.#store.runs.create({ ...run, status: "rejected", finishedAt: now });
      this.#audit?.record({
        ts: now,
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId,
        workspaceId: null,
        action: "run.rejected",
        detail: { runId: run.id, reason: "queue_full" },
      });
      await this.#sender.reply(
        message.chat,
        message.id,
        `当前任务队列已满（最多 ${this.#config.security.max_queued_prompts} 条）。请等待完成或发送 !stop 清空队列。`,
      );
      return { accepted: false, runId: run.id, queued: false };
    }

    this.#store.runs.create(run);
    const queued = this.#queue.enqueue(run, message, permissions, {
      rawText: inputMessage.text,
      profile,
    });
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
    if (this.#maintenance) {
      return { ok: false, reason: "正在重载 OpenCode 配置，请稍后重试。" };
    }
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
      workspaceId: null,
      sessionId: null,
      actorQq: userId,
      agent: null,
      model: null,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
    });
    this.#logger.info({ chatKey, userId, projectId }, "Conversation project changed");
    return { ok: true };
  }

  resetSession(chatKey: string): { ok: boolean; reason?: string } {
    if (this.#maintenance) {
      return { ok: false, reason: "正在重载 OpenCode 配置，请稍后重试。" };
    }
    if (this.#queue.active(chatKey) !== null) {
      return { ok: false, reason: "当前有任务运行中，请先发送 !stop。" };
    }
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null) {
      return { ok: false, reason: "还没有会话。请先发送 !use <项目>。" };
    }
    // Clear the OpenCode session but keep model/agent preferences so `!new`
    // does not silently undo the user's choices.
    this.#store.conversations.setSession(chatKey, null, conversation.agent, conversation.model);
    this.#logger.info({ chatKey }, "Conversation session cleared");
    return { ok: true };
  }

  async setModel(chatKey: string, model: string): Promise<{ ok: boolean; reason?: string }> {
    const guard = this.#preferenceGuard(chatKey);
    if (guard !== null) return guard;
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null)
      return { ok: false, reason: "还没有选择项目，请先发送 !use <项目>。" };
    if (conversation.sessionId !== null) {
      try {
        await this.#agent.switchModel(conversation.sessionId, model);
      } catch (error) {
        return { ok: false, reason: `切换模型失败：${describeError(error)}` };
      }
    }
    this.#store.conversations.setSession(
      chatKey,
      conversation.sessionId,
      conversation.agent,
      model,
    );
    this.#logger.info({ chatKey, model }, "Conversation model changed");
    return { ok: true };
  }

  async setAgent(chatKey: string, agent: string): Promise<{ ok: boolean; reason?: string }> {
    const guard = this.#preferenceGuard(chatKey);
    if (guard !== null) return guard;
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null)
      return { ok: false, reason: "还没有选择项目，请先发送 !use <项目>。" };
    if (conversation.sessionId !== null) {
      try {
        await this.#agent.switchAgent(conversation.sessionId, agent);
      } catch (error) {
        return { ok: false, reason: `切换 agent 失败：${describeError(error)}` };
      }
      if (conversation.model === null) {
        await this.#applyAgentModelToSession(
          chatKey,
          conversation.projectId,
          conversation.sessionId,
          agent,
        );
      }
    }
    this.#store.conversations.setSession(
      chatKey,
      conversation.sessionId,
      agent,
      conversation.model,
    );
    this.#logger.info({ chatKey, agent }, "Conversation agent changed");
    return { ok: true };
  }

  async #resolveAgentModel(projectId: string, agentId: string): Promise<string | null> {
    const project = this.#config.projects[projectId];
    if (project === undefined) return null;
    try {
      const agents = await this.#agent.listAgents(project.path);
      return agents.find((entry) => entry.id === agentId)?.model ?? null;
    } catch (error) {
      this.#logger.warn(
        { err: error, projectId, agent: agentId },
        "Failed to resolve agent frontmatter model",
      );
      return null;
    }
  }

  async #applyAgentModelToSession(
    chatKey: string,
    projectId: string,
    sessionId: string,
    agent: string,
  ): Promise<void> {
    const model = await this.#resolveAgentModel(projectId, agent);
    if (model === null) {
      this.#logger.warn(
        { chatKey, agent },
        "Selected agent has no frontmatter model; keeping the current session model. Send !new to fully apply the agent default.",
      );
      return;
    }
    try {
      await this.#agent.switchModel(sessionId, model);
      this.#logger.info(
        { chatKey, agent, model },
        "Applied agent frontmatter model to live session",
      );
    } catch (error) {
      this.#logger.warn(
        { err: error, chatKey, agent, model },
        "Failed to apply agent frontmatter model to live session; !new may be needed",
      );
    }
  }

  async switchSession(
    chatKey: string,
    session: AgentSession,
  ): Promise<{ ok: boolean; reason?: string }> {
    const guard = this.#preferenceGuard(chatKey);
    if (guard !== null) return guard;
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null)
      return { ok: false, reason: "还没有选择项目，请先发送 !use <项目>。" };
    const agent = session.agent ?? conversation.agent;
    if (conversation.model === null && agent !== null) {
      await this.#applyAgentModelToSession(chatKey, conversation.projectId, session.id, agent);
    }
    this.#store.conversations.setSession(chatKey, session.id, agent, conversation.model);
    this.#logger.info({ chatKey, sessionId: session.id }, "Conversation switched");
    return { ok: true };
  }

  #preferenceGuard(chatKey: string): { ok: false; reason: string } | null {
    if (this.#maintenance) {
      return { ok: false, reason: "正在重载 OpenCode 配置，请稍后重试。" };
    }
    if (this.#queue.active(chatKey) !== null) {
      return { ok: false, reason: "当前有任务运行中，请先发送 !stop。" };
    }
    if (this.#queue.pendingCount(chatKey) > 0) {
      return { ok: false, reason: "当前还有排队任务，请先发送 !stop。" };
    }
    return null;
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

  workspaceStatus(projectId: string): WorkspaceStatus {
    return this.#workspaces.status(projectId);
  }

  async diff(
    projectId: string,
    sessionId: string | null,
  ): Promise<{
    workspace: WorkspaceDiff;
    session: Awaited<ReturnType<AgentPort["getDiff"]>> | null;
  }> {
    const workspace = await this.#workspaces.diff(projectId);
    let session: Awaited<ReturnType<AgentPort["getDiff"]>> | null = null;
    if (sessionId !== null) {
      try {
        session = await this.#agent.getDiff(sessionId);
      } catch (error) {
        this.#logger.debug({ err: error, sessionId }, "Session diff unavailable");
      }
    }
    return { workspace, session };
  }

  cleanWorkspaces(): number {
    return this.#workspaces.cleanup();
  }

  async applyAgentDefaultModel(
    agentId: string,
    model: string,
  ): Promise<{ updated: number; failed: number; warnings: string[] }> {
    const defaultAgent = this.#config.opencode.default_agent;
    const targets = this.#store.conversations.list().filter((conversation) => {
      if (conversation.sessionId === null || conversation.model !== null) return false;
      if (conversation.agent === agentId) return true;
      if (conversation.agent !== null) return false;
      const projectAgent = this.#config.projects[conversation.projectId]?.agent ?? null;
      return (projectAgent ?? defaultAgent) === agentId;
    });

    let updated = 0;
    let failed = 0;
    const warnings: string[] = [];
    for (const conversation of targets) {
      const sessionId = conversation.sessionId;
      if (sessionId === null) continue;
      try {
        await this.#agent.switchModel(sessionId, model);
        updated += 1;
      } catch (error) {
        failed += 1;
        warnings.push(`${conversation.chatKey}: ${describeError(error)}`);
      }
    }
    this.#logger.info(
      { agentId, model, matched: targets.length, updated, failed },
      "Applied agent default model to live sessions",
    );
    return { updated, failed, warnings };
  }

  activeRuns(): number {
    return this.#queue.activeCount();
  }

  queuedRuns(): number {
    return this.#queue.queuedCount();
  }

  /**
   * Block new work while OpenCode's global configuration is being reloaded.
   * The gate is only granted when the queue is completely idle, so a reload
   * can never tear down a running location.
   */
  beginMaintenance(): MaintenanceGate {
    const activeRuns = this.#queue.activeCount();
    const queuedRuns = this.#queue.queuedCount();
    if (this.#maintenance) {
      return {
        ok: false,
        reason: "OpenCode 重载已在进行中。",
        activeRuns,
        queuedRuns,
      };
    }
    if (activeRuns > 0 || queuedRuns > 0) {
      return {
        ok: false,
        reason: "还有任务正在运行或排队，暂时不能重载 OpenCode。",
        activeRuns,
        queuedRuns,
      };
    }
    this.#maintenance = true;
    return { ok: true, activeRuns: 0, queuedRuns: 0 };
  }

  endMaintenance(): void {
    this.#maintenance = false;
  }

  /** Called after the last active and queued run has finished. */
  onIdle(listener: () => void): () => void {
    this.#idleListeners.add(listener);
    return () => this.#idleListeners.delete(listener);
  }

  #emitIdle(): void {
    for (const listener of this.#idleListeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.error({ err: error }, "Conversation idle listener failed");
      }
    }
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
    this.#workspaces.releaseAll();
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}
