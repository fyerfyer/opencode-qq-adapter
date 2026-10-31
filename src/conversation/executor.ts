import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { WorkspaceLease } from "../domain/workspace.js";
import type { AgentPort } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import { WorkspaceLockAbortedError } from "../workspace/manager.js";
import { friendlyError, isSessionMissing } from "./errors.js";
import { ProgressReporter } from "./progress-reporter.js";
import { PromptRunner } from "./prompt-runner.js";
import { ReplyDelivery } from "./reply-delivery.js";
import { collectResponse } from "./response.js";
import type { RunHooks } from "./run-hooks.js";
import { RunRecorder } from "./run-recorder.js";
import { SessionResolver } from "./session-resolver.js";
import { type ActiveRun, RunStoppedError } from "./types.js";

export type { RunHooks, RunMetadata } from "./run-hooks.js";

/** Executes one queued run: session resolution, prompt, wait, response, errors. */
export class RunExecutor {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #sender: MessageSender;
  readonly #logger: Logger;
  readonly #hooks: RunHooks;
  readonly #sessions: SessionResolver;
  readonly #prompts: PromptRunner;
  readonly #progress: ProgressReporter;
  readonly #delivery: ReplyDelivery;
  readonly #recorder: RunRecorder;

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
    this.#sessions = new SessionResolver({ config, store, agent, sender, logger });
    this.#prompts = new PromptRunner({ agent, logger });
    this.#progress = new ProgressReporter({ config, sender, logger });
    this.#delivery = new ReplyDelivery({ sender, logger });
    this.#recorder = new RunRecorder(store, hooks);
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
    let lease: WorkspaceLease | null = null;
    let sessionAgent: string | null = null;
    let sessionModel: string | null = null;
    const progress = this.#progress.start(message);
    this.#recorder.started(active);

    try {
      const project = this.#config.projects[record.projectId];
      if (project === undefined) {
        throw new Error(`Project '${record.projectId}' no longer exists in configuration`);
      }

      let directory: string;
      if (project.workspace === "none") {
        directory = active.profile?.directory ?? project.path;
        active.workspacePath = directory;
        phases.lockMs = Date.now() - phaseStart;
      } else {
        lease = await this.#hooks.workspaces.acquire(
          record.projectId,
          chatKey,
          record.id,
          active.abort.signal,
        );
        phases.lockMs = Date.now() - phaseStart;
        this.#recorder.setWorkspace(active, lease.id);
        active.workspacePath = lease.path;
        directory = lease.path;
      }
      phaseStart = Date.now();

      const conversation = this.#sessions.ensureConversation(
        chatKey,
        record.projectId,
        lease?.id ?? null,
        message.userId,
      );
      const ensured = await this.#sessions.ensureSession(conversation, directory, message, active);
      const session = ensured.session;
      const updated = ensured.conversation;
      sessionAgent = session.agent ?? active.agentName ?? null;
      sessionModel = session.model ?? active.modelRef ?? null;
      this.#recorder.setSession(active, session.id);
      this.#hooks.bindSession(session.id, active);
      this.#hooks.onSession?.(active, {
        id: session.id,
        agent: sessionAgent,
        model: sessionModel,
      });
      this.#logger.info(
        {
          runId: record.id,
          chatKey,
          projectId: record.projectId,
          sessionId: session.id,
          directory,
          agent: session.agent,
          model: session.model,
        },
        "Run session ready",
      );

      if (active.permissions.length > 0) {
        await this.#agent.updatePermissions(session.id, active.permissions);
      }
      phases.sessionMs = Date.now() - phaseStart;
      phaseStart = Date.now();
      if (active.stopRequested) throw new RunStoppedError();

      let receipt: { messageId: string; created: number };
      try {
        receipt = await this.#prompts.send(session.id, message);
      } catch (error) {
        if (!isSessionMissing(error)) throw error;
        this.#logger.warn(
          { err: error, sessionId: session.id },
          "Session vanished before prompt; recreating",
        );
        const recreated = await this.#sessions.createSession(
          updated,
          directory,
          message,
          active.permissions,
        );
        this.#hooks.unbindSession(session.id);
        sessionAgent = recreated.agent ?? active.agentName ?? null;
        sessionModel = recreated.model ?? active.modelRef ?? null;
        this.#recorder.setSession(active, recreated.id);
        this.#hooks.bindSession(recreated.id, active);
        this.#hooks.onSession?.(active, {
          id: recreated.id,
          agent: sessionAgent,
          model: sessionModel,
        });
        receipt = await this.#prompts.send(recreated.id, message);
      }
      phases.promptMs = Date.now() - phaseStart;
      phaseStart = Date.now();
      if (active.stopRequested) throw new RunStoppedError();

      await this.#prompts.waitForCompletion(
        record.id,
        record.sessionId ?? session.id,
        active,
        this.#config.opencode.prompt_timeout_ms,
      );
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

      active.replyText = finalText;
      const plan = await this.#hooks.formatReply?.(active, finalText);
      if (plan !== null && plan !== undefined) {
        await this.#delivery.sendPlan(message, active, plan);
      } else {
        await this.#sender.reply(message.chat, message.id, finalText);
      }
      const usage = result.usage ?? active.usage;
      const metadata = {
        agent: result.agent ?? sessionAgent ?? active.agentName ?? null,
        model: result.model ?? sessionModel ?? active.modelRef ?? null,
      };
      this.#recorder.completed(active, usage, metadata);
      // `conversation.model` is an explicit user override only. OpenCode may
      // report the derived agent/model on the session, so re-read the stored
      // preference instead of persisting the effective session model.
      const stored = this.#store.conversations.get(chatKey);
      this.#store.conversations.setSession(
        chatKey,
        record.sessionId,
        session.agent,
        stored?.model ?? null,
      );
      this.#logger.info(
        {
          runId: record.id,
          chatKey,
          projectId: record.projectId,
          sessionId: record.sessionId,
          agent: metadata.agent,
          model: metadata.model,
          durationMs: Date.now() - started,
          phases,
          usage,
        },
        "Run completed",
      );
    } catch (error) {
      const metadata = {
        agent: sessionAgent ?? active.agentName ?? null,
        model: sessionModel ?? active.modelRef ?? null,
      };
      if (
        active.stopRequested ||
        error instanceof RunStoppedError ||
        error instanceof WorkspaceLockAbortedError
      ) {
        this.#recorder.interrupted(active, metadata);
        this.#logger.info(
          {
            runId: record.id,
            chatKey,
            projectId: record.projectId,
            sessionId: record.sessionId,
            agent: metadata.agent,
            model: metadata.model,
            durationMs: Date.now() - started,
          },
          "Run interrupted by user",
        );
        return;
      }
      const friendly = friendlyError(error);
      this.#recorder.failed(active, friendly, metadata);
      this.#logger.error(
        {
          err: error,
          runId: record.id,
          chatKey,
          projectId: record.projectId,
          sessionId: record.sessionId,
          agent: metadata.agent,
          model: metadata.model,
          phases,
          durationMs: Date.now() - started,
        },
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
      await this.#progress.cleanup(message, progress);
    }
  }
}
