import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import type { AuditTrail } from "../../observability/audit.js";
import type { MessageSender } from "../../qq/sender.js";
import { PluginMessageService } from "../messages.js";
import type {
  PluginChat,
  PluginCommandContext,
  PluginCommandDefinition,
  PluginLogger,
} from "../sdk.js";
import {
  CHAT_TYPES,
  describeError,
  ROLES,
  requireCapability,
  toPluginChat,
  toPluginConversation,
  toPluginMessage,
} from "./convert.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginCommandInput,
  PluginConversationSource,
  PluginInstance,
  RegisteredCommand,
} from "./types.js";

/** Authorize and invoke plugin command handlers. */
export class PluginCommandDispatcher {
  readonly #config: AppConfig;
  readonly #sender: MessageSender;
  readonly #logger: Logger;
  readonly #audit: AuditTrail;
  readonly #now: () => number;
  readonly #registry: PluginRegistry;
  readonly #conversations: PluginConversationSource;

  constructor(options: {
    config: AppConfig;
    sender: MessageSender;
    logger: Logger;
    audit: AuditTrail;
    now: () => number;
    registry: PluginRegistry;
    conversations: PluginConversationSource;
  }) {
    this.#config = options.config;
    this.#sender = options.sender;
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#now = options.now;
    this.#registry = options.registry;
    this.#conversations = options.conversations;
  }

  /** Return true when a plugin handled the command (including permission denial). */
  async dispatch(input: PluginCommandInput): Promise<boolean> {
    if (this.#registry.maintenance) {
      await this.#sender
        .reply(input.message.chat, input.message.id, "插件正在重载，请稍后再试。")
        .catch(() => undefined);
      return true;
    }
    return this.#registry.track(this.#dispatch(input));
  }

  async #dispatch(input: PluginCommandInput): Promise<boolean> {
    const found = this.#registry.findCommand(input.name);
    if (found === null) return false;
    const { instance, command } = found;
    const definition = command.definition;
    const actor = input.message.userId;
    const chat = toPluginChat(input.message.chat);
    const logger = this.#pluginLogger(instance);

    if (!(await this.#authorize(instance, command, input, chat))) {
      return true;
    }

    const messages = new PluginMessageService({
      config: this.#config,
      sender: this.#sender,
      logger,
      dataDir: instance.dataDir,
    }).createApi();

    const conversation = toPluginConversation(
      this.#conversations.getConversation(input.message.chat.chatKey),
    );
    const context: PluginCommandContext = {
      message: toPluginMessage(input.message),
      args: input.args,
      rawArgs: input.rawArgs,
      actor: { qq: actor, role: input.actor },
      get conversation() {
        requireCapability(instance, "sessions");
        return conversation;
      },
      logger,
      reply: (text) => messages.reply(toPluginMessage(input.message), text),
      sendImage: (image) => {
        requireCapability(instance, "messages");
        return messages.sendImage(chat, image);
      },
      sendFile: (file) => {
        requireCapability(instance, "messages");
        return messages.sendFile(chat, file);
      },
    };

    try {
      const result = await definition.handler(context);
      if (typeof result === "string" && result.trim().length > 0) {
        await context.reply(result);
      }
      this.#audit.record({
        ts: this.#now(),
        actorQq: actor,
        chatKey: input.message.chat.chatKey,
        projectId: conversation?.projectId ?? null,
        workspaceId: conversation?.workspaceId ?? null,
        action: "plugin.command",
        detail: {
          pluginId: instance.id,
          command: definition.name,
          args: input.args.length,
        },
      });
    } catch (error) {
      const message = describeError(error);
      logger.error({ err: error, command: definition.name }, "Plugin command failed");
      this.#audit.record({
        ts: this.#now(),
        actorQq: actor,
        chatKey: input.message.chat.chatKey,
        projectId: conversation?.projectId ?? null,
        workspaceId: conversation?.workspaceId ?? null,
        action: "plugin.command_failed",
        detail: { pluginId: instance.id, command: definition.name, error: message },
      });
      await this.#sender
        .reply(input.message.chat, input.message.id, `插件命令执行失败：${message}`)
        .catch(() => undefined);
    }
    return true;
  }

  async #authorize(
    instance: PluginInstance,
    command: RegisteredCommand,
    input: PluginCommandInput,
    chat: PluginChat,
  ): Promise<boolean> {
    const definition = command.definition;
    const roles = definition.roles ?? ROLES;
    if (!roles.includes(input.actor)) {
      await this.#sender
        .reply(
          input.message.chat,
          input.message.id,
          `命令 !${definition.name} 需要 ${roles.join("/")} 权限。`,
        )
        .catch(() => undefined);
      this.#auditDenied(instance, definition, input, "role");
      return false;
    }
    const chats = definition.chats ?? CHAT_TYPES;
    if (!chats.includes(chat.type)) {
      await this.#sender
        .reply(
          input.message.chat,
          input.message.id,
          `命令 !${definition.name} 不支持当前会话类型。`,
        )
        .catch(() => undefined);
      this.#auditDenied(instance, definition, input, "chat_type");
      return false;
    }
    return true;
  }

  #auditDenied(
    instance: PluginInstance,
    command: PluginCommandDefinition,
    input: PluginCommandInput,
    reason: string,
  ): void {
    this.#audit.record({
      ts: this.#now(),
      actorQq: input.message.userId,
      chatKey: input.message.chat.chatKey,
      projectId: null,
      workspaceId: null,
      action: "plugin.command_denied",
      detail: { pluginId: instance.id, command: command.name, reason },
    });
  }

  #pluginLogger(instance: PluginInstance): PluginLogger {
    return this.#logger.child({ pluginId: instance.id });
  }
}
