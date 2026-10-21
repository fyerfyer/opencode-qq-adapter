import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { ActiveRun } from "../conversation/types.js";
import { privateChat } from "../domain/chat.js";
import type { MessageSender } from "../qq/sender.js";

export interface OwnerNotifierOptions {
  config: AppConfig;
  sender: MessageSender;
  logger: Logger;
  now?: () => number;
}

/** Sends operational alerts to configured owner accounts over QQ private chat. */
export class OwnerNotifier {
  readonly #config: AppConfig;
  readonly #sender: MessageSender;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #owners: number[];
  readonly #dedupe = new Map<string, number>();

  constructor(options: OwnerNotifierOptions) {
    this.#config = options.config;
    this.#sender = options.sender;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#owners = Object.entries(options.config.users)
      .filter(([, user]) => user.role === "owner")
      .map(([qq]) => Number(qq))
      .filter((qq) => Number.isFinite(qq) && qq > 0);
  }

  get enabled(): boolean {
    return this.#config.notifications.owner_alerts.enabled && this.#owners.length > 0;
  }

  async notify(text: string, options: { key?: string; ttlMs?: number } = {}): Promise<void> {
    if (!this.enabled) return;
    const key = options.key;
    if (key !== undefined) {
      const until = this.#dedupe.get(key);
      const now = this.#now();
      if (until !== undefined && until > now) return;
      this.#dedupe.set(key, now + (options.ttlMs ?? 60 * 60 * 1000));
      if (this.#dedupe.size > 500) {
        for (const [entry, expiresAt] of this.#dedupe) {
          if (expiresAt <= now) this.#dedupe.delete(entry);
        }
      }
    }
    for (const owner of this.#owners) {
      try {
        await this.#sender.send(privateChat(owner), text);
      } catch (error) {
        this.#logger.warn({ err: error, owner }, "Failed to send owner alert");
      }
    }
  }

  async startup(recoveredRuns: number, releasedWorkspaces: number): Promise<void> {
    if (!this.#config.notifications.owner_alerts.on_startup) return;
    const details = [
      recoveredRuns > 0 ? `${recoveredRuns} 个未完成任务已标记为 interrupted` : null,
      releasedWorkspaces > 0 ? `${releasedWorkspaces} 个工作区锁已恢复` : null,
    ].filter((value): value is string => value !== null);
    await this.notify(["OpenCode QQ Adapter 已启动。", ...details].join("\n"), { key: "startup" });
  }

  async runFailed(active: ActiveRun, error: string): Promise<void> {
    if (!this.#config.notifications.owner_alerts.on_run_failure) return;
    await this.notify(
      [
        "⚠️ OpenCode 任务失败",
        `项目：${active.record.projectId}`,
        `会话：${active.record.chatKey}`,
        `Run：${active.record.id}`,
        `错误：${error.slice(0, 500)}`,
      ].join("\n"),
      { key: `run-failed:${active.record.id}`, ttlMs: 10 * 60 * 1000 },
    );
  }

  async budgetExceeded(
    actorQq: number,
    projectId: string,
    reason: string,
    message: string,
  ): Promise<void> {
    if (!this.#config.notifications.owner_alerts.on_budget_exceeded) return;
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    await this.notify(
      ["⚠️ 预算 / 限流触发", `QQ：${actorQq}`, `项目：${projectId}`, message].join("\n"),
      { key: `budget:${day}:${actorQq}:${projectId}:${reason}`, ttlMs: 12 * 60 * 60 * 1000 },
    );
  }
}
