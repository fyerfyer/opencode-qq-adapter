import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { ResolvedReplyPlan } from "../../conversation/reply-plan.js";
import type { ActiveRun, RunUsage } from "../../conversation/types.js";
import type { RunStatus } from "../../domain/conversation.js";
import type { IncomingMessage } from "../../domain/message.js";
import type { AuditTrail } from "../../observability/audit.js";
import type {
  PluginConfigReloadContext,
  PluginConversationProfile,
  PluginEventMap,
  PluginProfileContext,
  PluginPromptContext,
  PluginReplyContext,
  PluginRunContext,
  PluginRunStatus,
} from "../sdk.js";
import {
  isPromptPatch,
  isRecord,
  toPluginChat,
  toPluginConversation,
  toPluginMessage,
  toPluginQuote,
  withTimeout,
} from "./convert.js";
import { normalizePluginProfile } from "./profile.js";
import type { PluginRegistry } from "./registry.js";
import { normalizeReplyPlan } from "./reply-plan.js";
import type { PluginConversationSource, PluginProfileResult, PluginPromptResult } from "./types.js";

const HOOK_TIMEOUT_MS = 2_000;
const REPLY_HOOK_TIMEOUT_MS = 4_000;
const EVENT_TIMEOUT_MS = 2_000;
const MAX_PLUGIN_CONTEXT_CHARS = 12_000;
const TRUNCATION_MARKER = "…（插件上下文已截断）";

/** Run plugin profile/prompt/reply/run hooks and event subscriptions. */
export class PluginHooksDispatcher {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #audit: AuditTrail;
  readonly #now: () => number;
  readonly #registry: PluginRegistry;
  readonly #conversations: PluginConversationSource;

  constructor(options: {
    config: AppConfig;
    logger: Logger;
    audit: AuditTrail;
    now: () => number;
    registry: PluginRegistry;
    conversations: PluginConversationSource;
  }) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#now = options.now;
    this.#registry = options.registry;
    this.#conversations = options.conversations;
  }

  /** Resolve a plugin-provided run profile before prompt injection and queueing. */
  async resolveProfile(message: IncomingMessage, projectId: string): Promise<PluginProfileResult> {
    const hooks = this.#registry.loadedHooks("resolveConversationProfile");
    if (hooks.length === 0) return { profile: null, plugins: [] };

    const base: PluginProfileContext = {
      message: toPluginMessage(message),
      projectId,
      conversation: toPluginConversation(this.#conversations.getConversation(message.chat.chatKey)),
    };
    for (const { instance, hook } of hooks) {
      const handler = hook.definition.resolveConversationProfile;
      if (handler === undefined) continue;
      try {
        const raw = await withTimeout(
          Promise.resolve(handler(base)),
          HOOK_TIMEOUT_MS,
          `resolveConversationProfile hook of ${instance.id}`,
        );
        if (!isRecord(raw)) continue;
        const profile = await normalizePluginProfile({
          raw,
          projectId,
          pluginId: instance.id,
          config: this.#config,
          logger: this.#logger,
        });
        if (profile !== null) return { profile, plugins: [instance.id] };
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id, projectId },
          "Plugin resolveConversationProfile hook failed; continuing",
        );
      }
    }
    return { profile: null, plugins: [] };
  }

  async beforePrompt(
    message: IncomingMessage,
    projectId: string,
    profile: PluginConversationProfile | null = null,
    /** Core-owned context block (e.g. a quoted message) inserted after plugin prepends. */
    promptPrefix = "",
  ): Promise<PluginPromptResult> {
    const hooks = this.#registry.loadedHooks("beforePrompt");
    const prefix = promptPrefix.trim();
    if (hooks.length === 0) {
      const text = joinPromptParts([prefix, message.text]);
      return {
        text,
        modified: text !== message.text,
        plugins: [],
        truncated: false,
        injectedChars: 0,
        originalInjectedChars: 0,
      };
    }

    const base: PluginPromptContext = {
      message: toPluginMessage(message),
      projectId,
      conversation: toPluginConversation(this.#conversations.getConversation(message.chat.chatKey)),
      profile,
    };
    const prepends: string[] = [];
    const appends: string[] = [];
    const plugins: string[] = [];

    for (const { instance, hook } of hooks) {
      const handler = hook.definition.beforePrompt;
      if (handler === undefined) continue;
      try {
        const patch = await withTimeout(
          Promise.resolve(handler(base)),
          HOOK_TIMEOUT_MS,
          `beforePrompt hook of ${instance.id}`,
        );
        if (!isPromptPatch(patch)) continue;
        if (typeof patch.prepend === "string" && patch.prepend.trim().length > 0) {
          prepends.push(patch.prepend.trim());
          plugins.push(instance.id);
        }
        if (typeof patch.append === "string" && patch.append.trim().length > 0) {
          appends.push(patch.append.trim());
          plugins.push(instance.id);
        }
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id },
          "Plugin beforePrompt hook failed; continuing",
        );
      }
    }

    if (prepends.length === 0 && appends.length === 0) {
      const text = joinPromptParts([prefix, message.text]);
      return {
        text,
        modified: text !== message.text,
        plugins: [],
        truncated: false,
        injectedChars: 0,
        originalInjectedChars: 0,
      };
    }

    const capped = capPluginContext(prepends.join("\n\n"), appends.join("\n\n"));
    const text = joinPromptParts([capped.prepend, prefix, message.text, capped.append]);
    if (capped.truncated) {
      this.#logger.warn(
        {
          chatKey: message.chat.chatKey,
          plugins: [...new Set(plugins)],
          originalChars: capped.originalChars,
          injectedChars: capped.injectedChars,
        },
        "Plugin prompt context exceeded the budget; truncated",
      );
      this.#audit.record({
        ts: this.#now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId,
        workspaceId: null,
        action: "plugin.context_truncated",
        detail: {
          plugins: [...new Set(plugins)],
          originalChars: capped.originalChars,
          injectedChars: capped.injectedChars,
        },
      });
    }
    return {
      text,
      modified: text !== message.text,
      plugins: [...new Set(plugins)],
      truncated: capped.truncated,
      injectedChars: capped.injectedChars,
      originalInjectedChars: capped.originalChars,
    };
  }

  /** Let a plugin shape the final reply into ordered segments. */
  async formatReply(active: ActiveRun, text: string): Promise<ResolvedReplyPlan | null> {
    const hooks = this.#registry.loadedHooks("formatReply");
    if (hooks.length === 0) return null;
    const context: PluginReplyContext = {
      message: toPluginMessage(active.message),
      projectId: active.record.projectId,
      conversation: toPluginConversation(
        this.#conversations.getConversation(active.message.chat.chatKey),
      ),
      profile: active.profile ?? null,
      text,
    };
    for (const { instance, hook } of hooks) {
      const handler = hook.definition.formatReply;
      if (handler === undefined) continue;
      try {
        const raw = await withTimeout(
          Promise.resolve(handler(context)),
          REPLY_HOOK_TIMEOUT_MS,
          `formatReply hook of ${instance.id}`,
        );
        const plan = await normalizeReplyPlan({
          instance,
          active,
          value: raw,
          config: this.#config,
          logger: this.#logger,
          audit: this.#audit,
          now: this.#now,
        });
        if (plan !== null) return plan;
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id, runId: active.record.id },
          "Plugin formatReply hook failed; sending the original reply",
        );
      }
    }
    return null;
  }

  async afterRun(
    active: ActiveRun,
    status: RunStatus,
    usage: RunUsage | null,
    error: string | null,
  ): Promise<void> {
    return this.#registry.track(this.#afterRun(active, status, usage, error));
  }

  async #afterRun(
    active: ActiveRun,
    status: RunStatus,
    usage: RunUsage | null,
    error: string | null,
  ): Promise<void> {
    if (status !== "completed" && status !== "failed" && status !== "interrupted") return;
    const context: PluginRunContext = {
      runId: active.record.id,
      chat: toPluginChat(active.message.chat),
      userId: active.message.userId,
      senderName: active.message.senderName,
      projectId: active.record.projectId,
      workspaceId: active.workspaceId,
      sessionId: active.record.sessionId,
      status: status as PluginRunStatus,
      usage: usage === null ? null : { cost: usage.cost, tokens: { ...usage.tokens } },
      error,
      durationMs: Math.max(0, this.#now() - active.record.startedAt),
      promptText: active.message.text,
      userText: active.rawText ?? active.message.text,
      quote: active.message.quote === undefined ? null : toPluginQuote(active.message.quote),
      replyText: active.replyText ?? null,
    };

    for (const { instance, hook } of this.#registry.loadedHooks("afterRun")) {
      const handler = hook.definition.afterRun;
      if (handler === undefined) continue;
      try {
        await withTimeout(
          Promise.resolve(handler(context)),
          HOOK_TIMEOUT_MS,
          `afterRun hook of ${instance.id}`,
        );
      } catch (hookError) {
        this.#logger.warn(
          { err: hookError, pluginId: instance.id, runId: context.runId },
          "Plugin afterRun hook failed; continuing",
        );
      }
    }
    await this.emit("run.finished", context);
  }

  async configReloaded(context: PluginConfigReloadContext): Promise<void> {
    for (const { instance, hook } of this.#registry.loadedHooks("onConfigReload")) {
      const handler = hook.definition.onConfigReload;
      if (handler === undefined) continue;
      try {
        await withTimeout(
          Promise.resolve(handler(context)),
          HOOK_TIMEOUT_MS,
          `onConfigReload hook of ${instance.id}`,
        );
      } catch (error) {
        this.#logger.warn(
          { err: error, pluginId: instance.id },
          "Plugin onConfigReload hook failed; continuing",
        );
      }
    }
    await this.emit("config.reloaded", context);
  }

  async emit<K extends keyof PluginEventMap>(type: K, event: PluginEventMap[K]): Promise<void> {
    for (const instance of this.#registry.sorted()) {
      if (instance.status !== "loaded") continue;
      for (const subscription of instance.events) {
        if (subscription.type !== type) continue;
        try {
          await withTimeout(
            Promise.resolve(subscription.handler(event)),
            EVENT_TIMEOUT_MS,
            `${type} event of ${instance.id}`,
          );
        } catch (error) {
          this.#logger.warn(
            { err: error, pluginId: instance.id, event: type },
            "Plugin event handler failed; continuing",
          );
        }
      }
    }
  }
}

function capPluginContext(
  prepend: string,
  append: string,
): {
  prepend: string;
  append: string;
  truncated: boolean;
  originalChars: number;
  injectedChars: number;
} {
  const separatorChars = (prepend.length > 0 ? 2 : 0) + (append.length > 0 ? 2 : 0);
  const originalChars = prepend.length + append.length + separatorChars;
  if (originalChars <= MAX_PLUGIN_CONTEXT_CHARS) {
    return { prepend, append, truncated: false, originalChars, injectedChars: originalChars };
  }

  const contentBudget = MAX_PLUGIN_CONTEXT_CHARS - separatorChars;
  const prependBudget = Math.floor(
    (contentBudget * prepend.length) / Math.max(1, prepend.length + append.length),
  );
  const appendBudget = contentBudget - prependBudget;
  const cappedPrepend = truncateContext(prepend, prependBudget);
  const cappedAppend = truncateContext(append, appendBudget);
  return {
    prepend: cappedPrepend,
    append: cappedAppend,
    truncated: true,
    originalChars,
    injectedChars: cappedPrepend.length + cappedAppend.length + separatorChars,
  };
}

function truncateContext(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  if (budget <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, budget);
  return `${text.slice(0, budget - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}

function joinPromptParts(parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}
