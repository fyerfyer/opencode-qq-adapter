import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { AgentPort, AgentSession } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { ConversationMaintenance } from "./maintenance.js";
import type { ChatRunQueue } from "./queue.js";

export interface PreferenceResult {
  ok: boolean;
  reason?: string;
}

/** Model, agent and session preference mutations for one conversation. */
export class ConversationPreferences {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #logger: Logger;
  readonly #maintenance: ConversationMaintenance;
  readonly #queue: ChatRunQueue;

  constructor(options: {
    config: AppConfig;
    store: StorePort;
    agent: AgentPort;
    logger: Logger;
    maintenance: ConversationMaintenance;
    queue: ChatRunQueue;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#agent = options.agent;
    this.#logger = options.logger;
    this.#maintenance = options.maintenance;
    this.#queue = options.queue;
  }

  async setModel(chatKey: string, model: string): Promise<PreferenceResult> {
    const guard = this.#guard(chatKey);
    if (guard !== null) return guard;
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null) {
      return { ok: false, reason: "还没有选择项目，请先发送 !use <项目>。" };
    }
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

  async setAgent(chatKey: string, agent: string): Promise<PreferenceResult> {
    const guard = this.#guard(chatKey);
    if (guard !== null) return guard;
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null) {
      return { ok: false, reason: "还没有选择项目，请先发送 !use <项目>。" };
    }
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

  async switchSession(chatKey: string, session: AgentSession): Promise<PreferenceResult> {
    const guard = this.#guard(chatKey);
    if (guard !== null) return guard;
    const conversation = this.#store.conversations.get(chatKey);
    if (conversation === null) {
      return { ok: false, reason: "还没有选择项目，请先发送 !use <项目>。" };
    }
    const agent = session.agent ?? conversation.agent;
    if (conversation.model === null && agent !== null) {
      await this.#applyAgentModelToSession(chatKey, conversation.projectId, session.id, agent);
    }
    this.#store.conversations.setSession(chatKey, session.id, agent, conversation.model);
    this.#logger.info({ chatKey, sessionId: session.id }, "Conversation switched");
    return { ok: true };
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

  #guard(chatKey: string): { ok: false; reason: string } | null {
    if (this.#maintenance.active) {
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
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}
