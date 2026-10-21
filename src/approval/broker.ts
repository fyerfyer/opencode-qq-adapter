import type { Logger } from "pino";
import { ulid } from "ulid";
import type { AppConfig } from "../config/schema.js";
import type { ApprovalRecord } from "../domain/approval.js";
import { chatFromKey } from "../domain/chat.js";
import type { IncomingMessage } from "../domain/message.js";
import type { AgentPermissionRequest, ApprovalDecision } from "../domain/permission.js";
import { AuditTrail } from "../observability/audit.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { AgentEvent, AgentPort } from "../ports/agent.js";
import type { StorePort } from "../ports/store.js";
import type { MessageSender } from "../qq/sender.js";
import { formatApprovalList, formatApprovalPrompt, formatResolvedApproval } from "./format.js";

export type ApprovalFailureReason =
  | "not_found"
  | "forbidden"
  | "not_pending"
  | "expired"
  | "ambiguous";

export type ApprovalResolution =
  | { ok: true; approval: ApprovalRecord; decision: ApprovalDecision }
  | { ok: false; reason: ApprovalFailureReason; message: string };

export interface ApprovalBrokerOptions {
  config: AppConfig;
  store: StorePort;
  agent: AgentPort;
  sender: MessageSender;
  policy: PolicyEngine;
  audit?: AuditTrail;
  logger: Logger;
  now?: () => number;
}

/**
 * Bridges OpenCode `permission.asked` events to QQ approvals.
 *
 * The broker owns only approval UX and state. The actual security decision is
 * still enforced by OpenCode's permission ruleset; an approval merely answers
 * an `ask` rule. A deny rule never reaches this broker.
 */
export class ApprovalBroker {
  readonly #config: AppConfig;
  readonly #store: StorePort;
  readonly #agent: AgentPort;
  readonly #sender: MessageSender;
  readonly #policy: PolicyEngine;
  readonly #audit: AuditTrail;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Child session -> parent session, learned from session.created events. */
  readonly #sessionParents = new Map<string, string>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: ApprovalBrokerOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#agent = options.agent;
    this.#sender = options.sender;
    this.#policy = options.policy;
    this.#audit = options.audit ?? new AuditTrail(options.store, options.logger);
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#agent.subscribe((event) => this.#onAgentEvent(event));
    void this.#reconcileStaleApprovals();
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const pending = this.#store.approvals.listPending();
    await Promise.allSettled(
      pending.map((approval) => this.#rejectWithAgent(approval, "bridge_shutdown", "cancelled")),
    );
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  pending(chatKey: string): ApprovalRecord[] {
    return this.#store.approvals.findPendingByChat(chatKey);
  }

  pendingList(chatKey: string): string {
    return formatApprovalList(this.pending(chatKey), this.#now());
  }

  /**
   * Resolve an approval from a QQ command or numeric reply.
   * The caller does not need to check permissions; the broker does that.
   */
  async resolve(
    message: IncomingMessage,
    idOrPrefix: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalResolution> {
    const pending = this.#store.approvals.findPendingByChat(message.chat.chatKey);
    const query = idOrPrefix.trim().toLowerCase();
    const matches =
      query.length === 0
        ? pending
        : pending.filter(
            (approval) =>
              approval.shortId.toLowerCase().startsWith(query) ||
              approval.id.toLowerCase().startsWith(query),
          );

    if (matches.length === 0) {
      const text = "未找到待审批请求，可能已处理或已超时。";
      await this.#send(message, text);
      return { ok: false, reason: "not_found", message: text };
    }
    if (matches.length > 1) {
      const text = "审批 ID 前缀匹配到多个请求，请提供更长的 ID。";
      await this.#send(message, text);
      return { ok: false, reason: "ambiguous", message: text };
    }

    const approval = matches[0];
    if (approval === undefined) {
      return { ok: false, reason: "not_found", message: "未找到待审批请求。" };
    }
    return this.#resolveApproval(approval, message, decision, "command");
  }

  /** Numeric/word replies and quoted replies. Returns true when consumed. */
  async handleTextReply(message: IncomingMessage): Promise<boolean> {
    const decision = parseApprovalDecision(message.text);
    if (decision === null) return false;

    let approval: ApprovalRecord | null = null;
    if (message.replyToId !== undefined) {
      approval = this.#store.approvals.findPendingByMessage(
        message.chat.chatKey,
        message.replyToId,
      );
    }
    if (approval === null) {
      const pending = this.#store.approvals.findPendingByChat(message.chat.chatKey);
      if (pending.length === 0) return false;
      if (pending.length > 1) {
        await this.#send(
          message,
          "当前有多个待审批请求。请引用审批消息回复，或发送 !approve ID once|always|reject。",
        );
        return true;
      }
      approval = pending[0] ?? null;
    }
    if (approval === null) return false;

    await this.#resolveApproval(approval, message, decision, "reply");
    return true;
  }

  /** Called by `!stop`: reject every pending request in a chat. */
  async rejectChat(chatKey: string, reason = "stop_command"): Promise<number> {
    const pending = this.#store.approvals.findPendingByChat(chatKey);
    await Promise.allSettled(
      pending.map((approval) => this.#rejectWithAgent(approval, reason, "rejected")),
    );
    return pending.length;
  }

  /** Called when a session is interrupted or disappears. */
  async rejectSession(sessionId: string, reason = "session_interrupted"): Promise<number> {
    const pending = this.#store.approvals.findPendingBySession(sessionId);
    await Promise.allSettled(
      pending.map((approval) => this.#rejectWithAgent(approval, reason, "cancelled")),
    );
    return pending.length;
  }

  #onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "session.created":
        this.#rememberSession(event);
        break;
      case "permission.asked":
        void this.#handleAsked(event).catch((error) => {
          this.#logger.error({ err: error }, "Failed to handle permission.asked event");
        });
        break;
      case "permission.replied":
        this.#handleReplied(event);
        break;
      case "session.execution.interrupted":
        if (event.sessionId !== null) {
          void this.rejectSession(event.sessionId, "session_interrupted").catch(() => undefined);
        }
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.idle":
        if (event.sessionId !== null) this.#cancelPending(event.sessionId);
        break;
      default:
        break;
    }
  }

  async #handleAsked(event: AgentEvent): Promise<void> {
    const request = parsePermissionRequest(event);
    if (request === null) return;
    const existing = this.#store.approvals.getByPermission(request.sessionId, request.id);
    if (existing !== null) return;

    const ownership = this.#resolveOwnership(request.sessionId);
    const conversation = ownership?.conversation ?? null;
    const activeRun =
      this.#store.runs.activeForSession(request.sessionId) ??
      (ownership ? this.#store.runs.activeForSession(ownership.rootSessionId) : null);
    const actorQq = activeRun?.actorQq ?? conversation?.actorQq ?? null;
    if (conversation === null || actorQq === null) {
      this.#ignoreOrphan(request);
      return;
    }

    const chat = chatFromKey(conversation.chatKey, actorQq);
    if (chat === null) {
      this.#ignoreOrphan(request);
      return;
    }

    const now = this.#now();
    const timeoutMs = this.#config.opencode.permission_timeout_ms;
    const approval = this.#createApproval({
      request,
      chatKey: conversation.chatKey,
      actorQq,
      projectId: conversation.projectId,
      runId: activeRun?.id ?? null,
      requestedAt: now,
      expiresAt: now + timeoutMs,
    });

    if (activeRun !== null) this.#store.runs.setStatus(activeRun.id, "waiting_permission");

    const text = formatApprovalPrompt(approval, Math.round(timeoutMs / 1000));
    try {
      const sent = await this.#sender.send(chat, text);
      if (sent.messageId !== null && sent.messageId.length > 0) {
        this.#store.approvals.update(approval.id, { qqMessageId: sent.messageId });
      }
    } catch (error) {
      this.#logger.error(
        { err: error, approvalId: approval.id },
        "Failed to send approval prompt to QQ; approval remains available via !approve",
      );
    }

    const timer = setTimeout(() => {
      void this.#expire(approval.id).catch((error) => {
        this.#logger.error({ err: error, approvalId: approval.id }, "Failed to expire approval");
      });
    }, timeoutMs);
    timer.unref?.();
    this.#timers.set(approval.id, timer);

    this.#audit.record({
      ts: now,
      actorQq,
      chatKey: conversation.chatKey,
      projectId: conversation.projectId,
      workspaceId: null,
      action: "approval.requested",
      detail: {
        approvalId: approval.id,
        shortId: approval.shortId,
        permissionId: request.id,
        action: request.action,
        resources: request.resources,
      },
    });
    this.#logger.info(
      {
        approvalId: approval.id,
        shortId: approval.shortId,
        action: request.action,
        sessionId: request.sessionId,
        chatKey: conversation.chatKey,
      },
      "Approval requested",
    );
  }

  #rememberSession(event: AgentEvent): void {
    const data = asRecord(event.data);
    const sessionId = stringField(data, "sessionID") ?? event.sessionId;
    const parentId = stringField(data, "parentID");
    if (sessionId !== null && parentId !== null && sessionId !== parentId) {
      this.#sessionParents.set(sessionId, parentId);
      if (this.#sessionParents.size > 2000) {
        const oldest = this.#sessionParents.keys().next().value;
        if (typeof oldest === "string") this.#sessionParents.delete(oldest);
      }
    }
  }

  #resolveOwnership(sessionId: string): {
    conversation: NonNullable<ReturnType<StorePort["conversations"]["get"]>>;
    rootSessionId: string;
  } | null {
    let current = sessionId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth += 1) {
      const conversation = this.#store.conversations.findBySession(current);
      if (conversation !== null) return { conversation, rootSessionId: current };
      const parent = this.#sessionParents.get(current);
      if (parent === undefined || seen.has(parent)) return null;
      seen.add(parent);
      current = parent;
    }
    return null;
  }

  #handleReplied(event: AgentEvent): void {
    const data = asRecord(event.data);
    const requestId = stringField(data, "requestID") ?? stringField(data, "id");
    const sessionId = event.sessionId ?? stringField(data, "sessionID");
    if (requestId === null || sessionId === null) return;
    const approval = this.#store.approvals.getByPermission(sessionId, requestId);
    if (approval === null || approval.status !== "pending") return;
    const reply = stringField(data, "reply");
    const decision: ApprovalDecision =
      reply === "reject" ? "reject" : reply === "always" ? "always" : "once";
    this.#store.approvals.update(approval.id, {
      status: decision === "reject" ? "rejected" : "approved",
      decision,
      repliedAt: this.#now(),
    });
    this.#clearTimer(approval.id);
    if (approval.runId !== null) this.#resumeRun(approval.runId);
  }

  async #resolveApproval(
    approval: ApprovalRecord,
    message: IncomingMessage,
    decision: ApprovalDecision,
    source: "command" | "reply",
  ): Promise<ApprovalResolution> {
    if (message.chat.chatKey !== approval.chatKey) {
      return this.#denyApproval(message, "forbidden", "不能在当前会话审批另一个会话的请求。");
    }
    if (!this.#canApprove(approval, message)) {
      this.#audit.record({
        ts: this.#now(),
        actorQq: message.userId,
        chatKey: approval.chatKey,
        projectId: approval.projectId,
        workspaceId: null,
        action: "approval.forbidden",
        detail: { approvalId: approval.id, permissionId: approval.permissionId },
      });
      return this.#denyApproval(message, "forbidden", "你没有权限审批该请求。");
    }
    if (approval.status !== "pending") {
      return this.#denyApproval(message, "not_pending", "该审批请求已被处理。");
    }
    if (this.#now() >= approval.expiresAt) {
      await this.#expire(approval.id);
      return this.#denyApproval(message, "expired", "该审批请求已超时。");
    }

    try {
      await this.#agent.replyPermission(approval.sessionId, approval.permissionId, decision);
    } catch (error) {
      this.#logger.warn(
        { err: error, approvalId: approval.id },
        "Failed to deliver permission reply to OpenCode",
      );
      this.#store.approvals.update(approval.id, {
        status: "cancelled",
        repliedAt: this.#now(),
        repliedBy: message.userId,
        decision,
      });
      this.#clearTimer(approval.id);
      const text = "审批回复失败，OpenCode 可能已结束该操作，请稍后重试。";
      await this.#send(message, text);
      return { ok: false, reason: "not_pending", message: text };
    }

    const now = this.#now();
    this.#store.approvals.update(approval.id, {
      status: decision === "reject" ? "rejected" : "approved",
      decision,
      repliedAt: now,
      repliedBy: message.userId,
    });
    this.#clearTimer(approval.id);
    if (approval.runId !== null) this.#resumeRun(approval.runId);

    this.#audit.record({
      ts: now,
      actorQq: message.userId,
      chatKey: approval.chatKey,
      projectId: approval.projectId,
      workspaceId: null,
      action: "approval.resolved",
      detail: {
        approvalId: approval.id,
        permissionId: approval.permissionId,
        decision,
        source,
        latencyMs: now - approval.requestedAt,
      },
    });
    await this.#send(message, formatResolvedApproval(approval, decision));
    return {
      ok: true,
      approval: { ...approval, status: decision === "reject" ? "rejected" : "approved" },
      decision,
    };
  }

  async #expire(approvalId: string): Promise<void> {
    const approval = this.#store.approvals.get(approvalId);
    if (approval === null || approval.status !== "pending") return;
    this.#clearTimer(approval.id);
    try {
      await this.#agent.replyPermission(approval.sessionId, approval.permissionId, "reject");
    } catch (error) {
      this.#logger.debug({ err: error, approvalId }, "Permission already gone at timeout");
    }
    const now = this.#now();
    this.#store.approvals.update(approval.id, {
      status: "expired",
      decision: "reject",
      repliedAt: now,
    });
    if (approval.runId !== null) this.#resumeRun(approval.runId);
    const chat = chatFromKey(approval.chatKey, approval.actorQq);
    if (chat !== null) {
      await this.#sender
        .send(chat, `审批 #${approval.shortId} 已超时，已自动拒绝。`)
        .catch((error) => {
          this.#logger.warn({ err: error, approvalId }, "Failed to send timeout notice");
        });
    }
    this.#audit.record({
      ts: now,
      actorQq: approval.actorQq,
      chatKey: approval.chatKey,
      projectId: approval.projectId,
      workspaceId: null,
      action: "approval.expired",
      detail: { approvalId: approval.id, permissionId: approval.permissionId },
    });
  }

  async #rejectWithAgent(
    approval: ApprovalRecord,
    reason: string,
    status: "rejected" | "cancelled",
  ): Promise<void> {
    if (approval.status !== "pending") return;
    this.#clearTimer(approval.id);
    try {
      await this.#agent.replyPermission(
        approval.sessionId,
        approval.permissionId,
        "reject",
        reason,
      );
    } catch (error) {
      this.#logger.debug({ err: error, approvalId: approval.id }, "Permission already gone");
    }
    const now = this.#now();
    this.#store.approvals.update(approval.id, {
      status,
      decision: "reject",
      repliedAt: now,
    });
    if (approval.runId !== null) this.#resumeRun(approval.runId);
    this.#audit.record({
      ts: now,
      actorQq: approval.actorQq,
      chatKey: approval.chatKey,
      projectId: approval.projectId,
      workspaceId: null,
      action: "approval.cancelled",
      detail: { approvalId: approval.id, permissionId: approval.permissionId, reason, status },
    });
  }

  #resumeRun(runId: string): void {
    const run = this.#store.runs.get(runId);
    if (run?.status === "waiting_permission") {
      this.#store.runs.setStatus(runId, "running");
    }
  }

  #cancelPending(sessionId: string): void {
    for (const approval of this.#store.approvals.findPendingBySession(sessionId)) {
      this.#clearTimer(approval.id);
      this.#store.approvals.update(approval.id, {
        status: "cancelled",
        repliedAt: this.#now(),
      });
    }
  }

  /**
   * A permission request for a session this bridge does not own belongs to
   * another OpenCode client (for example the TUI). Leave it untouched so we do
   * not reject decisions the user is handling elsewhere.
   */
  #ignoreOrphan(request: AgentPermissionRequest): void {
    this.#logger.debug(
      { sessionId: request.sessionId, permissionId: request.id },
      "Ignoring permission request for a session not owned by this bridge",
    );
    this.#audit.record({
      ts: this.#now(),
      actorQq: null,
      chatKey: null,
      projectId: null,
      workspaceId: null,
      action: "approval.ignored",
      detail: {
        sessionId: request.sessionId,
        permissionId: request.id,
        action: request.action,
        reason: "unknown_session",
      },
    });
  }

  #createApproval(input: {
    request: AgentPermissionRequest;
    chatKey: string;
    actorQq: number;
    projectId: string;
    runId: string | null;
    requestedAt: number;
    expiresAt: number;
  }): ApprovalRecord {
    const existingShortIds = new Set(
      this.#store.approvals.findPendingByChat(input.chatKey).map((approval) => approval.shortId),
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = ulid(input.requestedAt);
      const shortId = id.slice(-8).toUpperCase();
      if (existingShortIds.has(shortId)) continue;
      const approval: ApprovalRecord = {
        id,
        shortId,
        runId: input.runId,
        chatKey: input.chatKey,
        actorQq: input.actorQq,
        projectId: input.projectId,
        sessionId: input.request.sessionId,
        permissionId: input.request.id,
        action: input.request.action,
        resources: input.request.resources,
        message: input.request.message,
        status: "pending",
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt,
        repliedAt: null,
        repliedBy: null,
        decision: null,
        qqMessageId: null,
      };
      this.#store.approvals.create(approval);
      return approval;
    }
    throw new Error("Unable to allocate a unique approval ID");
  }

  #canApprove(approval: ApprovalRecord, message: IncomingMessage): boolean {
    const actor = this.#policy.actor(message.userId);
    if (actor === null) return false;
    const groupId = message.chat.groupId;
    if (groupId !== undefined) {
      const group = this.#policy.group(groupId);
      if (group === null || !group.enabled) return false;
      if (!group.allowed_users.includes(String(message.userId))) return false;
      if (!this.#policy.canUseProject(actor, message.userId, approval.projectId, groupId).allowed) {
        return false;
      }
      if (group.mode === "shared") return actor.role === "owner" || actor.role === "admin";
      if (actor.role === "owner" || actor.role === "admin") return true;
      return approval.actorQq === message.userId;
    }

    if (actor.role === "owner") return true;
    if (actor.role === "admin") {
      return this.#policy.canUseProject(actor, message.userId, approval.projectId).allowed;
    }
    return approval.actorQq === message.userId;
  }

  async #denyApproval(
    message: IncomingMessage,
    reason: ApprovalFailureReason,
    text: string,
  ): Promise<ApprovalResolution> {
    await this.#send(message, text);
    return { ok: false, reason, message: text };
  }

  async #send(message: IncomingMessage, text: string): Promise<void> {
    try {
      await this.#sender.reply(message.chat, message.id, text);
    } catch (error) {
      this.#logger.warn({ err: error }, "Failed to send approval notice");
    }
  }

  async #reconcileStaleApprovals(): Promise<void> {
    const pending = this.#store.approvals.listPending();
    if (pending.length === 0) return;
    for (const approval of pending) {
      await this.#rejectWithAgent(approval, "bridge_restart", "cancelled");
    }
    this.#logger.warn(
      { count: pending.length },
      "Rejected approvals left pending by a previous process",
    );
  }

  #clearTimer(approvalId: string): void {
    const timer = this.#timers.get(approvalId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(approvalId);
    }
  }
}

export function parseApprovalDecision(text: string): ApprovalDecision | null {
  const normalized = text.trim().toLowerCase();
  switch (normalized) {
    case "1":
    case "once":
      return "once";
    case "2":
    case "always":
      return "always";
    case "3":
    case "reject":
      return "reject";
    default:
      return null;
  }
}

function parsePermissionRequest(event: AgentEvent): AgentPermissionRequest | null {
  const data = asRecord(event.data);
  const id = stringField(data, "id") ?? stringField(data, "requestID");
  const sessionId = event.sessionId ?? stringField(data, "sessionID");
  const action = stringField(data, "action");
  const resources = Array.isArray(data.resources)
    ? data.resources.filter((item): item is string => typeof item === "string")
    : [];
  if (id === null || sessionId === null || action === null) return null;
  return {
    id,
    sessionId,
    action,
    resources,
    save: Array.isArray(data.save)
      ? data.save.filter((item): item is string => typeof item === "string")
      : [],
    message: typeof data.message === "string" ? data.message : null,
    metadata: isRecord(data.metadata) ? data.metadata : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
