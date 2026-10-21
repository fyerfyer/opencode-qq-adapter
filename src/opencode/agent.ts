import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { AgentPermissionRequest, ApprovalDecision } from "../domain/permission.js";
import type { WorkspaceDiffFile } from "../domain/workspace.js";
import type {
  AgentEvent,
  AgentEventStatus,
  AgentHealth,
  AgentMessage,
  AgentModel,
  AgentPort,
  AgentPromptInput,
  AgentPromptReceipt,
  AgentSession,
  AgentSessionInput,
  AgentSummary,
} from "../ports/agent.js";
import { AgentUnavailableError } from "./errors.js";
import { OpenCodeEventStream } from "./events.js";
import {
  isNotFound,
  mapMessage,
  mapPermissionRequest,
  mapSession,
  parseModelRef,
} from "./mappers.js";
import { type Client, OpenCodeService } from "./service.js";

type OpenCodeConfig = AppConfig["opencode"];

/**
 * AgentPort implementation for OpenCode V2. Session/API calls live here;
 * connection lifecycle and event streaming are delegated to focused helpers.
 */
export class OpenCodeAgent implements AgentPort {
  readonly #logger: Logger;
  readonly #service: OpenCodeService;
  readonly #events: OpenCodeEventStream;
  readonly #listeners = new Set<(event: AgentEvent) => void>();

  constructor(config: OpenCodeConfig, logger: Logger) {
    this.#logger = logger;
    this.#service = new OpenCodeService(config, logger);
    this.#events = new OpenCodeEventStream({
      config,
      getClient: () => this.#service.getClient(),
      logger,
      onEvent: (event) => this.#emit(event),
    });
    this.#service.setOnClientChanged((client) => {
      if (client === null) {
        void this.#events.stop();
      } else {
        this.#events.restart();
      }
    });
  }

  async start(): Promise<void> {
    const health = await this.#service.health(true);
    if (health.healthy) {
      this.#events.start();
    } else {
      this.#logger.warn(
        { error: health.error },
        "OpenCode service is not healthy at startup; it will be retried on demand",
      );
    }
  }

  async stop(): Promise<void> {
    await this.#events.stop();
    await this.#service.stop();
  }

  async health(force = false): Promise<AgentHealth> {
    return this.#service.health(force);
  }

  async createSession(input: AgentSessionInput): Promise<AgentSession> {
    const client = await this.#getHealthyClient();
    const model = input.model ? parseModelRef(input.model) : undefined;
    const session = await client.session.create({
      location: { directory: input.directory },
      ...(input.title ? { title: input.title } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      ...(input.permissions && input.permissions.length > 0
        ? { permissions: input.permissions }
        : {}),
    });
    this.#logger.info(
      {
        sessionId: session.id,
        directory: input.directory,
        agent: session.agent,
        model: session.model,
      },
      "OpenCode session created",
    );
    return mapSession(session);
  }

  async getSession(sessionId: string): Promise<AgentSession | null> {
    const client = await this.#service.getClient();
    try {
      return mapSession(await client.session.get({ sessionID: sessionId }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptReceipt> {
    const client = await this.#getHealthyClient();
    const inbox = await client.session.prompt({
      sessionID: input.sessionId,
      text: input.text,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    });
    return { messageId: inbox.id, created: inbox.time.created };
  }

  async waitForCompletion(sessionId: string, signal?: AbortSignal): Promise<void> {
    const client = await this.#service.getClient();
    await client.session.wait({ sessionID: sessionId }, signal ? { signal } : undefined);
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const client = await this.#service.getClient();
    const result = await client.session.interrupt({ sessionID: sessionId });
    return result.interrupted;
  }

  async updatePermissions(
    sessionId: string,
    permissions: NonNullable<AgentSessionInput["permissions"]>,
  ): Promise<void> {
    const client = await this.#getHealthyClient();
    await client.session.update({ sessionID: sessionId, permissions });
    this.#logger.debug(
      { sessionId, rules: permissions.length },
      "Applied session permission ruleset",
    );
  }

  async listPermissions(sessionId: string): Promise<AgentPermissionRequest[]> {
    const client = await this.#service.getClient();
    const requests = await client.permission.list({ sessionID: sessionId });
    return requests.map(mapPermissionRequest);
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    message?: string,
  ): Promise<void> {
    const client = await this.#service.getClient();
    await client.permission.reply({
      sessionID: sessionId,
      requestID: requestId,
      decision,
      ...(message ? { message } : {}),
    });
  }

  async listMessages(sessionId: string, limit = 50): Promise<AgentMessage[]> {
    const client = await this.#service.getClient();
    const response = await client.message.list({
      sessionID: sessionId,
      limit,
      order: "desc",
    });
    return response.data.map(mapMessage);
  }

  async listModels(directory?: string): Promise<AgentModel[]> {
    const client = await this.#service.getClient();
    const response = await client.model.list(
      directory !== undefined ? { location: { directory } } : undefined,
    );
    return response.data.map((model) => ({
      id: `${model.providerID}/${model.modelID}`,
      providerID: model.providerID,
      modelID: model.modelID,
      name: model.name,
      enabled: model.enabled,
      variants: model.variants.map((variant) => variant.id),
    }));
  }

  async listAgents(directory?: string): Promise<AgentSummary[]> {
    const client = await this.#service.getClient();
    const response = await client.agent.list(
      directory !== undefined ? { location: { directory } } : undefined,
    );
    return response.data.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description ?? null,
      mode: agent.mode,
      model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : null,
      hidden: agent.hidden,
    }));
  }

  async listSessions(directory: string, limit = 20): Promise<AgentSession[]> {
    const client = await this.#service.getClient();
    const response = await client.session.list({ directory, limit });
    return response.data.map(mapSession);
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    const client = await this.#service.getClient();
    await client.session.switchModel({ sessionID: sessionId, model: parseModelRef(model) });
  }

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    const client = await this.#service.getClient();
    await client.session.switchAgent({ sessionID: sessionId, agent });
  }

  async getDiff(sessionId: string): Promise<WorkspaceDiffFile[]> {
    const client = await this.#service.getClient();
    const files = await client.session.diff({ sessionID: sessionId });
    return files.map((file) => ({
      file: file.file,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.patch.length > 0 ? { patch: file.patch } : {}),
    }));
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  eventStatus(): AgentEventStatus {
    return this.#events.status();
  }

  getLastError(): string | null {
    return this.#events.getLastError() ?? this.#service.getLastError();
  }

  async #getHealthyClient(): Promise<Client> {
    await this.#service.getClient();
    const health = await this.#service.health();
    if (!health.healthy) {
      throw new AgentUnavailableError(health.error ?? "OpenCode service is unavailable");
    }
    this.#events.start();
    return this.#service.getClient();
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#logger.error({ err: error, event: event.type }, "OpenCode event listener failed");
      }
    }
  }
}
