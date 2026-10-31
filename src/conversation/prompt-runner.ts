import type { Logger } from "pino";
import type { IncomingMessage } from "../domain/message.js";
import type { AgentPort, AgentPromptReceipt } from "../ports/agent.js";
import { toPromptFiles } from "./response.js";
import { type ActiveRun, RunStoppedError } from "./types.js";

/** Send one prompt and wait for its session to become idle. */
export class PromptRunner {
  readonly #agent: AgentPort;
  readonly #logger: Logger;

  constructor(options: { agent: AgentPort; logger: Logger }) {
    this.#agent = options.agent;
    this.#logger = options.logger;
  }

  async send(sessionId: string, message: IncomingMessage): Promise<AgentPromptReceipt> {
    return this.#agent.prompt({
      sessionId,
      text: message.text,
      ...(message.images.length > 0 ? { files: message.images.flatMap(toPromptFiles) } : {}),
    });
  }

  async waitForCompletion(
    runId: string,
    sessionId: string,
    active: ActiveRun,
    timeoutMs: number,
  ): Promise<void> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new Error(`prompt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const signal = AbortSignal.any([active.abort.signal, timeoutController.signal]);
    try {
      await this.#agent.waitForCompletion(sessionId, signal);
    } catch (error) {
      if (active.stopRequested) throw new RunStoppedError();
      if (timeoutController.signal.aborted) {
        await this.#agent.interrupt(sessionId).catch(() => undefined);
        throw new Error(`OpenCode 处理超时（${Math.round(timeoutMs / 1000)} 秒），已请求中断。`);
      }
      // A failed wait does not prove that the execution finished. Only fall
      // back to message history when OpenCode reports an idle session;
      // otherwise the run is still active (for example blocked on a tool).
      const current = await this.#agent.getSession(sessionId);
      if (current === null) {
        throw new Error("等待 OpenCode 完成时会话已不存在，请重新发送消息。");
      }
      if (current.idle === null) {
        throw new Error(
          "等待 OpenCode 完成时连接中断，但会话仍在运行。请发送 !status 查看状态，或发送 !stop 中断后重试。",
        );
      }
      this.#logger.warn(
        { err: error, runId },
        "Wait for OpenCode completion failed; session is idle, trying message history",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
