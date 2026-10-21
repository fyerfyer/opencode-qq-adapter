import type { Logger } from "pino";
import type { ConversationRecord } from "../domain/conversation.js";
import type { AgentEvent, AgentPort } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";

export interface SessionOwner {
  conversation: ConversationRecord;
  rootSessionId: string;
}

/** Learns parent/subagent session relationships from OpenCode events. */
export class SessionOwnership {
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #logger: Logger;
  readonly #parents = new Map<string, string>();
  #unsubscribe: (() => void) | null = null;

  constructor(store: StorePort, agent: AgentPort, logger: Logger) {
    this.#store = store;
    this.#agent = agent;
    this.#logger = logger;
  }

  start(): void {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#agent.subscribe((event) => this.#onEvent(event));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  resolve(sessionId: string): SessionOwner | null {
    let current = sessionId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth += 1) {
      const conversation = this.#store.conversations.findBySession(current);
      if (conversation !== null) return { conversation, rootSessionId: current };
      const parent = this.#parents.get(current);
      if (parent === undefined || seen.has(parent)) return null;
      seen.add(parent);
      current = parent;
    }
    return null;
  }

  #onEvent(event: AgentEvent): void {
    if (event.type !== "session.created") return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof data.sessionID === "string" ? data.sessionID : (event.sessionId ?? null);
    const parentId = typeof data.parentID === "string" ? data.parentID : null;
    if (sessionId === null || parentId === null || sessionId === parentId) return;
    this.#parents.set(sessionId, parentId);
    if (this.#parents.size > 2000) {
      const oldest = this.#parents.keys().next().value;
      if (typeof oldest === "string") this.#parents.delete(oldest);
    }
    this.#logger.debug({ sessionId, parentId }, "Tracked child session ownership");
  }
}
