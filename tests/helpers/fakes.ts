import type { AppConfig } from "../../src/config/schema.js";
import { configSchema } from "../../src/config/schema.js";
import type { ChatRef, OutgoingSegment } from "../../src/domain/chat.js";
import type { ConversationRecord, RunRecord } from "../../src/domain/conversation.js";
import type { IncomingMessage } from "../../src/domain/message.js";
import type {
  AgentPermissionRequest,
  ApprovalDecision,
  PermissionRuleset,
} from "../../src/domain/permission.js";
import type { WorkspaceDiffFile } from "../../src/domain/workspace.js";
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
} from "../../src/ports/agent.js";
import type { OneBotPort, OneBotSendResult, OneBotStatus } from "../../src/ports/onebot.js";

let sessionSequence = 0;
let messageSequence = 0;

export class FakeAgent implements AgentPort {
  readonly sessions = new Map<string, AgentSession>();
  readonly sessionInputs: AgentSessionInput[] = [];
  readonly messages = new Map<string, AgentMessage[]>();
  readonly prompts: AgentPromptInput[] = [];
  readonly interrupts: string[] = [];
  readonly permissionUpdates: Array<{ sessionId: string; permissions: PermissionRuleset }> = [];
  readonly permissionReplies: Array<{
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
    message?: string;
  }> = [];
  readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  readonly listeners = new Set<(event: AgentEvent) => void>();
  readonly waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  readonly diffs = new Map<string, WorkspaceDiffFile[]>();
  readonly models: AgentModel[] = [
    {
      id: "fake/model-a",
      providerID: "fake",
      modelID: "model-a",
      name: "Fake Model A",
      enabled: true,
      variants: [],
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    },
    {
      id: "fake/model-b",
      providerID: "fake",
      modelID: "model-b",
      name: "Fake Model B",
      enabled: true,
      variants: ["fast"],
      capabilities: { tools: true, input: ["text"], output: ["text"] },
    },
  ];
  readonly agents: AgentSummary[] = [
    {
      id: "build",
      name: "Build",
      description: "Fake build agent",
      mode: "primary",
      model: null,
      hidden: false,
    },
  ];
  readonly switchedModels: Array<{ sessionId: string; model: string }> = [];
  readonly switchedAgents: Array<{ sessionId: string; agent: string }> = [];
  reloads = 0;

  autoComplete = true;
  answer = "fake answer";
  failWith: string | null = null;
  healthy = true;
  #lastError: string | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async health(): Promise<AgentHealth> {
    return {
      healthy: this.healthy,
      version: "2.0.32",
      url: "http://fake",
      checkedAt: Date.now(),
      error: this.healthy ? null : "fake unhealthy",
    };
  }

  async createSession(input: AgentSessionInput): Promise<AgentSession> {
    this.sessionInputs.push(input);
    const session: AgentSession = {
      id: `ses_fake_${++sessionSequence}`,
      title: input.title ?? null,
      agent: input.agent ?? null,
      model: input.model ?? null,
      projectId: "fake",
      created: Date.now(),
      updated: Date.now(),
      cost: 0,
      tokens: null,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async getSession(sessionId: string): Promise<AgentSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    this.pendingPermissions.delete(sessionId);
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptReceipt> {
    this.prompts.push(input);
    const created = Date.now();
    const message: AgentMessage = {
      id: `msg_fake_${++messageSequence}`,
      type: "user",
      text: input.text,
      created,
      error: null,
      cost: null,
      tokens: null,
    };
    this.messages.get(input.sessionId)?.unshift(message);
    return { messageId: message.id, created };
  }

  async waitForCompletion(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.failWith !== null) {
      this.#lastError = this.failWith;
      this.emit({
        type: "session.execution.failed",
        sessionId,
        data: { error: { type: "fake", message: this.failWith } },
        receivedAt: Date.now(),
      });
      this.failWith = null;
      return;
    }
    if (this.autoComplete) {
      this.#complete(sessionId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.set(sessionId, { resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          this.waiters.delete(sessionId);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  complete(sessionId: string): void {
    this.#complete(sessionId);
  }

  async interrupt(sessionId: string): Promise<boolean> {
    this.interrupts.push(sessionId);
    const waiter = this.waiters.get(sessionId);
    this.waiters.delete(sessionId);
    this.emit({
      type: "session.execution.interrupted",
      sessionId,
      data: { reason: "user" },
      receivedAt: Date.now(),
    });
    waiter?.resolve();
    return true;
  }

  async updatePermissions(sessionId: string, permissions: PermissionRuleset): Promise<void> {
    this.permissionUpdates.push({ sessionId, permissions });
  }

  async listPermissions(sessionId: string): Promise<AgentPermissionRequest[]> {
    return [...this.pendingPermissions.values()].filter(
      (request) => request.sessionId === sessionId,
    );
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    message?: string,
  ): Promise<void> {
    this.permissionReplies.push({
      sessionId,
      requestId,
      decision,
      ...(message ? { message } : {}),
    });
    this.pendingPermissions.delete(requestId);
  }

  askPermission(request: AgentPermissionRequest): void {
    this.pendingPermissions.set(request.id, request);
    this.emit({
      type: "permission.asked",
      sessionId: request.sessionId,
      data: {
        id: request.id,
        sessionID: request.sessionId,
        action: request.action,
        resources: request.resources,
        save: request.save,
        message: request.message ?? undefined,
      },
      receivedAt: Date.now(),
    });
  }

  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async listModels(): Promise<AgentModel[]> {
    return [...this.models];
  }

  async listAgents(): Promise<AgentSummary[]> {
    return [...this.agents];
  }

  async reloadConfig(): Promise<void> {
    this.reloads += 1;
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    this.switchedModels.push({ sessionId, model });
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("session not found");
    session.model = model;
  }

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    this.switchedAgents.push({ sessionId, agent });
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("session not found");
    session.agent = agent;
  }

  async getDiff(sessionId: string): Promise<WorkspaceDiffFile[]> {
    return [...(this.diffs.get(sessionId) ?? [])];
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventStatus(): AgentEventStatus {
    return { connected: true, lastEventAt: Date.now(), lastError: this.#lastError };
  }

  getLastError(): string | null {
    return this.#lastError;
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  #complete(sessionId: string): void {
    const message: AgentMessage = {
      id: `msg_fake_${++messageSequence}`,
      type: "assistant",
      text: this.answer,
      created: Date.now(),
      error: null,
      cost: 0.001,
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    this.messages.get(sessionId)?.unshift(message);
    this.emit({
      type: "session.execution.succeeded",
      sessionId,
      data: { sessionID: sessionId },
      receivedAt: Date.now(),
    });
    const waiter = this.waiters.get(sessionId);
    this.waiters.delete(sessionId);
    waiter?.resolve();
  }
}

export interface SentMessage {
  kind: "private" | "group" | "reply";
  chat?: ChatRef;
  replyTo?: string;
  segments: OutgoingSegment[];
}

export interface UploadedFile {
  kind: "private" | "group";
  targetId: number;
  file: string;
  name: string;
  folderId?: string;
}

export class FakeOneBot implements OneBotPort {
  readonly sent: SentMessage[] = [];
  readonly uploads: UploadedFile[] = [];
  readonly deleted: string[] = [];
  readonly imageUrls = new Map<string, string>();
  readonly listeners = new Set<(event: unknown) => void>();
  connected = true;
  /** Set to override the derived login state; `null` means use `connected`. */
  loginOk: boolean | null = null;
  selfId: number | null = 10000;
  lastEventAt: number | null = Date.now();
  lastError: string | null = null;
  loginInfoError: string | null = null;
  /** Set to block shutdown and verify cleanup ordering. */
  stopGate: Promise<void> | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    if (this.stopGate !== null) await this.stopGate;
  }

  async sendPrivate(userId: number, segments: OutgoingSegment[]): Promise<OneBotSendResult> {
    this.sent.push({
      kind: "private",
      chat: { type: "private", userId, chatKey: `private:${userId}` },
      segments,
    });
    return { messageId: String(1000 + this.sent.length) };
  }

  async sendGroup(groupId: number, segments: OutgoingSegment[]): Promise<OneBotSendResult> {
    this.sent.push({
      kind: "group",
      chat: { type: "group", userId: 0, groupId, chatKey: `group:${groupId}` },
      segments,
    });
    return { messageId: String(1000 + this.sent.length) };
  }

  async reply(
    chat: ChatRef,
    messageId: string,
    segments: OutgoingSegment[],
  ): Promise<OneBotSendResult> {
    this.sent.push({ kind: "reply", chat, replyTo: messageId, segments });
    return { messageId: String(1000 + this.sent.length) };
  }

  async uploadPrivateFile(userId: number, file: string, name: string): Promise<void> {
    this.uploads.push({ kind: "private", targetId: userId, file, name });
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.deleted.push(messageId);
  }

  async getImage(file: string): Promise<{ file: string; url: string; fileName: string }> {
    const url = this.imageUrls.get(file);
    if (url === undefined) throw new Error(`No fake image URL for ${file}`);
    return { file: `fake-${file}.png`, url, fileName: `${file}.png` };
  }

  async uploadGroupFile(
    groupId: number,
    file: string,
    name: string,
    folderId?: string,
  ): Promise<void> {
    this.uploads.push({
      kind: "group",
      targetId: groupId,
      file,
      name,
      ...(folderId ? { folderId } : {}),
    });
  }

  async getLoginInfo(): Promise<{ userId: number; nickname: string }> {
    if (this.loginInfoError !== null) {
      this.loginOk = false;
      throw new Error(this.loginInfoError);
    }
    this.loginOk = true;
    return { userId: this.selfId ?? 0, nickname: "FakeBot" };
  }

  status(): OneBotStatus {
    return {
      mode: "forward",
      connected: this.connected,
      loginOk: this.loginOk ?? this.connected,
      selfId: this.selfId,
      lastEventAt: this.lastEventAt,
      lastConnectedAt: Date.now(),
      lastError: this.lastError,
    };
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }

  texts(): string[] {
    return this.sent.map((message) =>
      message.segments
        .filter((segment) => segment.type === "text")
        .map((segment) => (segment.type === "text" ? segment.text : ""))
        .join(""),
    );
  }
}

export function makeTestConfig(options: {
  projectPath: string;
  userQQ?: string;
  maxQueued?: number;
}): AppConfig {
  return configSchema.parse({
    version: 2,
    onebot: {
      url: "ws://127.0.0.1:3001",
      access_token: "test-token",
      self_id: 10000,
    },
    opencode: { service: { mode: "off", base_url: "http://127.0.0.1:1" } },
    storage: {
      database_path: ":memory:",
      inbox_dir: `${options.projectPath}/.qq-inbox`,
    },
    workspaces: { root: `${options.projectPath}/.qq-workspaces` },
    default_project: "demo",
    users: {
      [options.userQQ ?? "20000"]: {
        role: "owner",
        projects: ["*"],
        write_projects: ["*"],
      },
    },
    projects: {
      demo: { path: options.projectPath },
    },
    security: {
      max_queued_prompts: options.maxQueued ?? 3,
      allow_private_image_urls: true,
    },
  });
}

export function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const userId = overrides.userId ?? 20000;
  return {
    id: overrides.id ?? "100",
    chat: overrides.chat ?? {
      type: "private",
      userId,
      chatKey: `private:${userId}`,
    },
    userId,
    senderName: "Tester",
    text: overrides.text ?? "hello",
    images: overrides.images ?? [],
    mentionsBot: overrides.mentionsBot ?? false,
    receivedAt: Date.now(),
    raw: {},
    ...overrides,
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function conversations(store: {
  conversations: { list(): ConversationRecord[] };
}): ConversationRecord[] {
  return store.conversations.list();
}

export function runs(
  store: { runs: { listRecent(chatKey: string, limit: number): RunRecord[] } },
  chatKey: string,
): RunRecord[] {
  return store.runs.listRecent(chatKey, 10);
}
