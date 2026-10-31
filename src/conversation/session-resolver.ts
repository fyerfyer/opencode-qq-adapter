import type { Logger } from "pino";
import { projectModels } from "../config/loader.js";
import type { AppConfig } from "../config/schema.js";
import type { ConversationRecord } from "../domain/conversation.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionRuleset } from "../domain/permission.js";
import type { AgentPort, AgentSession } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import { isSessionMissing } from "./errors.js";
import type { ActiveRun } from "./types.js";

/** Resolve or create the persisted conversation and its OpenCode session. */
export class SessionResolver {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #sender: MessageSender;
  readonly #logger: Logger;

  constructor(options: {
    config: AppConfig;
    store: StorePort;
    agent: AgentPort;
    sender: MessageSender;
    logger: Logger;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#agent = options.agent;
    this.#sender = options.sender;
    this.#logger = options.logger;
  }

  ensureConversation(
    chatKey: string,
    projectId: string,
    workspaceId: string | null,
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

  async ensureSession(
    conversation: ConversationRecord,
    directory: string,
    message: IncomingMessage,
    active: ActiveRun,
  ): Promise<{ session: AgentSession; conversation: ConversationRecord }> {
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
    const session = await this.createSession(conversation, directory, message, active.permissions);
    return { session, conversation: { ...conversation, sessionId: session.id } };
  }

  async createSession(
    conversation: ConversationRecord,
    directory: string,
    message: IncomingMessage,
    permissions: PermissionRuleset,
  ): Promise<AgentSession> {
    const project = this.#config.projects[conversation.projectId];
    if (project === undefined) {
      throw new Error(`Project '${conversation.projectId}' no longer exists`);
    }
    const resolved = projectModels(this.#config, project);
    const agent = conversation.agent ?? resolved.agent;
    const explicitModel = conversation.model;
    let model = explicitModel;
    if (model === null) {
      // Agent frontmatter wins over project/global defaults. When the agent
      // declares a model, omit the explicit model so OpenCode applies it.
      const agentModel = await this.#agentModel(agent, directory);
      model = agentModel === null ? resolved.model : null;
    }
    const session = await this.#agent.createSession({
      directory,
      title: `${conversation.projectId} · QQ ${message.userId}`,
      agent,
      model,
      ...(permissions.length > 0 ? { permissions } : {}),
    });
    this.#store.conversations.setSession(conversation.chatKey, session.id, agent, explicitModel);
    return session;
  }

  async #agentModel(agentId: string | null, directory: string): Promise<string | null> {
    if (agentId === null) return null;
    try {
      const agents = await this.#agent.listAgents(directory);
      return agents.find((entry) => entry.id === agentId)?.model ?? null;
    } catch (error) {
      this.#logger.warn(
        { err: error, agent: agentId, directory },
        "Failed to read OpenCode agents; falling back to configured model",
      );
      return null;
    }
  }
}
