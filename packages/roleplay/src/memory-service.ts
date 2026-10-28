import type { PluginAgent, PluginLogger } from "@opencode-qq/plugin-sdk";
import {
  applyOperations,
  type MemoryDoc,
  type MemoryDocRef,
  MemoryDocumentStore,
  parseDocument,
  type MemoryOperation,
} from "./memory-document.js";
import { buildConsolidationPrompt, parseConsolidation } from "./memory-ops.js";
import type { RoleplayOptions } from "./options.js";
import type {
  MemoryEvent,
  MemorySnippet,
  TranscriptStore,
} from "./transcript.js";

const FAILURE_RETRY_MS = 5 * 60_000;

export interface MemoryServiceOptions {
  transcript: TranscriptStore;
  documents: MemoryDocumentStore;
  agent: PluginAgent;
  logger: PluginLogger;
  options: RoleplayOptions;
  now?: () => number;
}

export interface RecordRunInput {
  personaId: string;
  personaName: string;
  chatKey: string;
  scope: string;
  actorQq: number;
  senderName: string;
  userText: string;
  replyText: string | null;
  sessionId: string | null;
  ts?: number;
}

export interface ConsolidateInput {
  personaId: string;
  personaName: string;
  chatKey: string;
  scope: string;
  actorQq: number;
  senderName: string;
}

export interface MemoryView {
  shared: boolean;
  user: MemoryDoc;
  scene: MemoryDoc | null;
  allUsers: MemoryDoc[];
  rawCount: number;
  lastEvent: MemoryEvent | null;
}

export interface MemoryRefreshResult {
  enabled: boolean;
  cooldown: boolean;
  changed: boolean;
  failed: boolean;
  summary: string;
}

export interface MemorySearchLine {
  source: string;
  section: string;
  line: string;
}

export interface MemorySearchResult {
  docs: MemorySearchLine[];
  messages: MemorySnippet[];
}

interface ConsolidateOutcome {
  changed: boolean;
  failed: boolean;
  summary: string;
}

/**
 * Markdown memory orchestration.
 *
 * Raw messages are written to SQLite for FTS/evidence. Stable memory lives in
 * Markdown documents and is updated by a background utility agent using
 * section-level operations. Every consolidation is recorded in memory_events.
 */
export class MemoryService {
  readonly #transcript: TranscriptStore;
  readonly #documents: MemoryDocumentStore;
  readonly #agent: PluginAgent;
  readonly #logger: PluginLogger;
  readonly #options: RoleplayOptions;
  readonly #now: () => number;
  readonly #pending = new Map<string, number>();
  readonly #jobs = new Map<string, Promise<ConsolidateOutcome>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #lastRefresh = new Map<string, number>();
  readonly #retryAfter = new Map<string, number>();
  readonly #generation = new Map<string, number>();
  #disposed = false;

  constructor(input: MemoryServiceOptions) {
    this.#transcript = input.transcript;
    this.#documents = input.documents;
    this.#agent = input.agent;
    this.#logger = input.logger;
    this.#options = input.options;
    this.#now = input.now ?? Date.now;
  }

  recordRun(input: RecordRunInput): void {
    if (this.#disposed) return;
    const ts = input.ts ?? this.#now();
    if (input.userText.trim().length > 0) {
      this.#transcript.addMessage({
        namespace: input.personaId,
        chatKey: input.chatKey,
        scope: input.scope,
        role: "user",
        speaker: input.senderName,
        text: input.userText,
        ts,
        sessionId: input.sessionId ?? undefined,
        actorQq: input.actorQq,
      });
    }
    if (input.replyText !== null && input.replyText.trim().length > 0) {
      this.#transcript.addMessage({
        namespace: input.personaId,
        chatKey: input.chatKey,
        scope: input.scope,
        role: "assistant",
        speaker: input.personaName,
        text: input.replyText,
        ts: ts + 1,
        sessionId: input.sessionId ?? undefined,
      });
    }
    if (!this.#options.memoryEnabled) return;
    const key = input.scope;
    const pending = (this.#pending.get(key) ?? 0) + 1;
    this.#pending.set(key, pending);
    this.#scheduleIdle(input);
    if (pending >= this.#options.memoryConsolidateEveryTurns) {
      void this.#enqueue(input);
    }
  }

  async refresh(input: ConsolidateInput): Promise<MemoryRefreshResult> {
    if (!this.#options.memoryEnabled) {
      return {
        enabled: false,
        cooldown: false,
        changed: false,
        failed: false,
        summary: "记忆整理未启用",
      };
    }
    const now = this.#now();
    const last = this.#lastRefresh.get(input.scope) ?? 0;
    if (now - last < this.#options.memoryRefreshCooldownMs) {
      return {
        enabled: true,
        cooldown: true,
        changed: false,
        failed: false,
        summary: "刚整理过，请稍后再试",
      };
    }
    this.#lastRefresh.set(input.scope, now);
    if (!this.#jobs.has(input.scope)) this.#pending.set(input.scope, 0);
    const outcome = await this.#enqueue(input);
    return {
      enabled: true,
      cooldown: false,
      changed: outcome.changed,
      failed: outcome.failed,
      summary: outcome.summary,
    };
  }

  async loadForPrompt(input: {
    personaId: string;
    scope: string;
    actorQq: number;
  }): Promise<{ shared: boolean; userDoc: string; sceneDoc: string }> {
    const bundle = await this.#documents.load({
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
    });
    return {
      shared: bundle.shared,
      userDoc: bundle.user.content,
      sceneDoc: bundle.scene?.content ?? "",
    };
  }

  async view(input: {
    personaId: string;
    scope: string;
    actorQq: number;
    allActors?: boolean;
  }): Promise<MemoryView> {
    const ref = {
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
    };
    const bundle = await this.#documents.load(ref);
    const allUsers =
      bundle.shared && input.allActors === true
        ? await this.#documents.loadAllUserDocs(ref)
        : [];
    return {
      shared: bundle.shared,
      user: bundle.user,
      scene: bundle.scene,
      allUsers,
      rawCount: this.#transcript.count(input.scope, input.personaId),
      lastEvent: this.#transcript.latestMemoryEvent(
        input.scope,
        input.personaId,
      ),
    };
  }

  async remember(input: {
    personaId: string;
    scope: string;
    actorQq: number;
    content: string;
  }): Promise<{ path: string }> {
    const inFlight = this.#jobs.get(input.scope);
    if (inFlight !== undefined) await inFlight;
    const ref = {
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
    };
    const content = input.content.replace(/\s+/g, " ").trim();
    const written = await this.#documents.appendManual(ref, content);
    this.#transcript.addMemoryEvent({
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
      action: "manual_add",
      summary: `手动记忆：${content.slice(0, 80)}`,
      detail: { section: "手动记忆", content, path: written.path },
      sourceMessageId: this.#transcript.latestMessageId(
        input.scope,
        input.personaId,
      ),
      now: this.#now(),
    });
    return { path: written.path };
  }

  async forgetAll(input: {
    personaId: string;
    scope: string;
    actorQq: number;
  }): Promise<{ messages: number; events: number }> {
    const inFlight = this.#jobs.get(input.scope);
    if (inFlight !== undefined) await inFlight;
    this.#generation.set(
      input.scope,
      (this.#generation.get(input.scope) ?? 0) + 1,
    );
    await this.#documents.forgetAll({
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
    });
    this.#pending.delete(input.scope);
    this.#retryAfter.delete(input.scope);
    this.#lastRefresh.delete(input.scope);
    this.#clearTimer(input.scope);
    return this.#transcript.forgetScope(input.scope, input.personaId);
  }

  async forgetSection(input: {
    personaId: string;
    scope: string;
    actorQq: number;
    section: string;
  }): Promise<boolean> {
    const inFlight = this.#jobs.get(input.scope);
    if (inFlight !== undefined) await inFlight;
    const removed = await this.#documents.forgetSection(
      {
        namespace: input.personaId,
        scope: input.scope,
        actorQq: input.actorQq,
      },
      input.section,
    );
    if (removed) {
      this.#transcript.addMemoryEvent({
        namespace: input.personaId,
        scope: input.scope,
        actorQq: input.actorQq,
        action: "manual_delete",
        summary: `删除 section：${input.section}`,
        detail: { section: input.section },
        now: this.#now(),
      });
    }
    return removed;
  }

  history(input: {
    personaId: string;
    scope: string;
    limit?: number;
  }): MemoryEvent[] {
    return this.#transcript.listMemoryEvents(
      input.scope,
      input.personaId,
      input.limit ?? this.#options.memoryHistoryLimit,
    );
  }

  lastEvent(input: { personaId: string; scope: string }): MemoryEvent | null {
    return this.#transcript.latestMemoryEvent(input.scope, input.personaId);
  }

  search(input: {
    personaId: string;
    scope: string;
    actorQq: number;
    query: string;
    allActors?: boolean;
    limit?: number;
  }): Promise<MemorySearchResult> {
    const query = input.query.trim();
    const limit = Math.max(
      1,
      Math.floor(input.limit ?? this.#options.memoryRawTopK),
    );
    const messages =
      query.length === 0
        ? []
        : this.#transcript.search({
            namespace: input.personaId,
            scope: input.scope,
            query,
            limit,
          });
    return this.#documents
      .load({
        namespace: input.personaId,
        scope: input.scope,
        actorQq: input.actorQq,
      })
      .then(async (bundle) => {
        const docs: MemorySearchLine[] = [];
        const userDocs =
          bundle.shared && input.allActors === true
            ? await this.#documents.loadAllUserDocs({
                namespace: input.personaId,
                scope: input.scope,
                actorQq: input.actorQq,
              })
            : bundle.user.exists
              ? [bundle.user]
              : [];
        for (const doc of userDocs) {
          docs.push(...searchDocument(doc, query, "用户记忆"));
        }
        if (bundle.scene?.exists === true) {
          docs.push(...searchDocument(bundle.scene, query, "群聊场景"));
        }
        return { docs: docs.slice(0, limit), messages };
      });
  }

  #scheduleIdle(input: RecordRunInput): void {
    const key = input.scope;
    this.#clearTimer(key);
    const delay = this.#options.memoryIdleDebounceMs;
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      if ((this.#pending.get(key) ?? 0) > 0) void this.#enqueue(input);
    }, delay);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  #clearTimer(key: string): void {
    const timer = this.#timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
  }

  #enqueue(input: ConsolidateInput): Promise<ConsolidateOutcome> {
    const key = input.scope;
    const existing = this.#jobs.get(key);
    if (existing !== undefined) return existing;
    const now = this.#now();
    const retryAfter = this.#retryAfter.get(key) ?? 0;
    if (now < retryAfter) {
      return Promise.resolve({
        changed: false,
        failed: true,
        summary: "上次整理失败，稍后重试",
      });
    }
    const job = (async (): Promise<ConsolidateOutcome> => {
      try {
        const outcome = await this.#consolidate(input);
        this.#retryAfter.delete(key);
        return outcome;
      } catch (error) {
        this.#retryAfter.set(key, this.#now() + FAILURE_RETRY_MS);
        this.#logger.warn(
          { err: error, namespace: input.personaId, scope: input.scope },
          "Roleplay memory consolidation failed; will retry later",
        );
        return {
          changed: false,
          failed: true,
          summary: "整理失败，稍后自动重试",
        };
      } finally {
        this.#jobs.delete(key);
      }
    })();
    this.#jobs.set(key, job);
    return job;
  }

  async #consolidate(input: ConsolidateInput): Promise<ConsolidateOutcome> {
    const generation = this.#generation.get(input.scope) ?? 0;
    const scheduledPending = this.#pending.get(input.scope) ?? 0;
    const lastId = this.#transcript.lastConsolidatedMessageId(
      input.scope,
      input.personaId,
    );
    const messages =
      lastId > 0
        ? this.#transcript.messagesAfter({
            chatKey: input.chatKey,
            namespace: input.personaId,
            afterId: lastId,
            limit: 40,
          })
        : this.#transcript.messagesTail({
            chatKey: input.chatKey,
            namespace: input.personaId,
            limit: 40,
          });
    if (messages.length === 0) {
      return { changed: false, failed: false, summary: "没有新的对话" };
    }

    const ref: MemoryDocRef = {
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
    };
    const bundle = await this.#documents.load(ref);
    const userMessages = bundle.shared
      ? this.#transcript.messagesTailForActor({
          chatKey: input.chatKey,
          namespace: input.personaId,
          actorQq: input.actorQq,
          limit: 40,
        })
      : messages;
    const prompt = buildConsolidationPrompt({
      personaName: input.personaName,
      userName: input.senderName,
      actorQq: input.actorQq,
      scope: input.scope,
      shared: bundle.shared,
      now: this.#now(),
      userDoc: bundle.user.content,
      sceneDoc: bundle.scene?.content ?? "",
      messages: userMessages,
      ...(bundle.shared ? { sceneMessages: messages } : {}),
      userMaxChars: this.#options.memoryUserMaxChars,
      sceneMaxChars: this.#options.memorySceneMaxChars,
    });
    const response = await this.#agent.complete({
      prompt,
      timeoutMs: this.#options.memoryUtilityTimeoutMs,
      label: "roleplay.memory.consolidate",
      chatKey: input.chatKey,
      actorQq: input.actorQq,
    });
    if (
      this.#disposed ||
      (this.#generation.get(input.scope) ?? 0) !== generation
    ) {
      return { changed: false, failed: false, summary: "记忆已被删除" };
    }
    const parsed = parseConsolidation(response.text);

    const userResult =
      parsed.userOperations.length > 0 || bundle.user.exists
        ? applyOperations(bundle.user.content, parsed.userOperations, "user")
        : { content: bundle.user.content, changed: false, changes: [] };
    const sceneResult =
      bundle.shared && bundle.scene !== null
        ? parsed.sceneOperations.length > 0 || bundle.scene.exists
          ? applyOperations(
              bundle.scene.content,
              parsed.sceneOperations,
              "scene",
            )
          : { content: bundle.scene.content, changed: false, changes: [] }
        : null;
    const changed = userResult.changed || sceneResult?.changed === true;

    if (userResult.changed) {
      await this.#documents.writeUser(ref, userResult.content);
    }
    if (sceneResult !== null && sceneResult.changed) {
      await this.#documents.writeScene(ref, sceneResult.content);
    }

    const sourceMessageId = messages.at(-1)?.id ?? lastId;
    this.#transcript.addMemoryEvent({
      namespace: input.personaId,
      scope: input.scope,
      actorQq: input.actorQq,
      action: "consolidate",
      summary: parsed.summary,
      detail: {
        user: parsed.userOperations,
        scene: parsed.sceneOperations,
        changes: [...userResult.changes, ...(sceneResult?.changes ?? [])],
      },
      sourceMessageId,
      now: this.#now(),
    });
    const remaining = Math.max(
      0,
      (this.#pending.get(input.scope) ?? scheduledPending) - scheduledPending,
    );
    if (remaining === 0) {
      this.#pending.delete(input.scope);
      this.#clearTimer(input.scope);
    } else {
      this.#pending.set(input.scope, remaining);
    }
    this.#logger.info(
      {
        namespace: input.personaId,
        scope: input.scope,
        changed,
        userOps: parsed.userOperations.length,
        sceneOps: parsed.sceneOperations.length,
      },
      "Roleplay memory consolidated",
    );
    return { changed, failed: false, summary: parsed.summary };
  }

  async idle(): Promise<void> {
    while (this.#jobs.size > 0) {
      await Promise.allSettled([...this.#jobs.values()]);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await this.idle();
  }
}

function searchDocument(
  doc: MemoryDoc,
  query: string,
  source: string,
): MemorySearchLine[] {
  if (query.length === 0 || !doc.exists) return [];
  const parsed = parseDocument(
    doc.content,
    doc.path.endsWith("scene.md") ? "scene" : "user",
  );
  const needle = query.toLowerCase();
  const result: MemorySearchLine[] = [];
  for (const [section, lines] of parsed.sections) {
    for (const line of lines) {
      if (line.toLowerCase().includes(needle)) {
        result.push({ source, section, line: line.trim() });
      }
    }
  }
  return result;
}
