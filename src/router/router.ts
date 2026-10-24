import type { IncomingMessage } from "../domain/message.js";
import { parseCommand } from "../domain/message.js";
import type { PluginRole } from "../plugins/sdk.js";
import { createCommands } from "./commands.js";
import { errorMessage } from "./format.js";
import type { CommandContext, CommandHandler, RouterDeps } from "./types.js";

/** Authorizes messages, dispatches commands and routes plain text to OpenCode. */
export class MessageRouter {
  readonly #deps: RouterDeps;
  readonly #commands: Map<string, CommandHandler>;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#commands = createCommands(deps);
  }

  async handle(message: IncomingMessage): Promise<void> {
    const decision = this.#deps.policy.authorize(message);
    if (!decision.allowed || decision.actor === null) {
      this.#deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId: null,
        workspaceId: null,
        action: "access.denied",
        detail: { reason: decision.reason, textLength: message.text.length },
      });
      this.#deps.logger.debug(
        { qq: message.userId, chatKey: message.chat.chatKey, reason: decision.reason },
        "Ignoring message from unauthorized actor",
      );
      return;
    }

    // Approval replies are allowed without an @ mention in groups when they
    // quote the approval prompt; otherwise group mention rules still apply.
    if (await this.#deps.approvals.handleTextReply(message)) return;

    const command = parseCommand(message.text);
    if (message.chat.type === "group") {
      if (
        command === undefined &&
        this.#deps.policy.isGroupMentionRequired(message.chat.groupId) &&
        !message.mentionsBot
      ) {
        return;
      }
    }

    if (command !== undefined) {
      await this.#dispatch(
        command.name,
        {
          message,
          args: command.args,
          rawArgs: command.rawArgs,
        },
        decision.actor.role,
      );
      return;
    }

    await this.#handlePrompt(message);
  }

  async #dispatch(name: string, context: CommandContext, actorRole: PluginRole): Promise<void> {
    const handler = this.#commands.get(name);
    if (handler === undefined) {
      const handledByPlugin =
        this.#deps.plugins !== undefined &&
        (await this.#deps.plugins.dispatchCommand({
          name,
          message: context.message,
          args: context.args,
          rawArgs: context.rawArgs,
          actor: actorRole,
          groupMode:
            context.message.chat.type === "group" && context.message.chat.groupId !== undefined
              ? this.#deps.policy.groupMode(context.message.chat.groupId)
              : null,
        }));
      if (handledByPlugin) return;
      await this.#deps.sender.reply(
        context.message.chat,
        context.message.id,
        `未知命令：!${name}\n发送 !help 查看可用命令。`,
      );
      return;
    }
    try {
      await handler(context);
    } catch (error) {
      this.#deps.logger.error({ err: error, command: name }, "Command failed");
      await this.#deps.sender
        .reply(context.message.chat, context.message.id, `命令执行失败：${errorMessage(error)}`)
        .catch(() => undefined);
    }
  }

  async #handlePrompt(message: IncomingMessage): Promise<void> {
    const { config, policy, conversations, sender, media } = this.#deps;
    const actor = policy.actor(message.userId);
    if (actor === null) return;

    if (message.text.length === 0 && message.images.length === 0) return;

    let images = message.images;
    if (images.length > 0) {
      if (!config.features.images) {
        images = [];
        await sender.reply(
          message.chat,
          message.id,
          "当前配置未启用图片输入，本条消息仅处理文字。",
        );
      } else {
        const prepared = await media.prepare(images);
        images = prepared.images;
        if (prepared.warnings.length > 0) {
          await sender.reply(message.chat, message.id, prepared.warnings.join("\n"));
        }
        if (images.length === 0) {
          if (message.text.length === 0) {
            await sender.reply(message.chat, message.id, "没有可处理的图片，请重试或改发文字。");
            return;
          }
        }
      }
    }

    const text =
      message.text.length > 0
        ? message.text
        : "请直接查看附件图片并描述其内容，不要使用 shell 工具。";
    if (text.length > config.security.max_prompt_chars) {
      await sender.reply(
        message.chat,
        message.id,
        `消息过长（${text.length} 字），上限为 ${config.security.max_prompt_chars} 字。`,
      );
      return;
    }

    let projectId: string | null = null;
    const conversation = conversations.getConversation(message.chat.chatKey);
    if (conversation !== null) {
      const allowed = policy.canUseProject(
        actor,
        message.userId,
        conversation.projectId,
        message.chat.groupId,
      );
      if (allowed.allowed) projectId = conversation.projectId;
    }

    let autoSelected = false;
    if (projectId === null) {
      const fallback = policy.defaultProject(actor, message.userId, message.chat.groupId);
      if (fallback === null) {
        await sender.reply(
          message.chat,
          message.id,
          "还没有选择项目，或你有多个可用项目。请先发送 !projects 查看，再发送 !use <项目>。",
        );
        return;
      }
      projectId = fallback.id;
      autoSelected = conversation === null;
    }

    const permissions = policy.permissionsFor(message, projectId);
    if (permissions === null) {
      await sender.reply(message.chat, message.id, "项目配置已失效，请联系管理员。");
      return;
    }

    const quota = this.#deps.quota.check(message.userId, projectId);
    if (!quota.allowed) {
      this.#deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId,
        workspaceId: null,
        action: "prompt.rejected",
        detail: { reason: quota.reason, textLength: message.text.length },
      });
      await sender.reply(message.chat, message.id, quota.message ?? "请求被限流，请稍后再试。");
      void this.#deps.notifier.budgetExceeded(
        message.userId,
        projectId,
        quota.reason ?? "unknown",
        quota.message ?? "请求被限流",
      );
      return;
    }

    if (autoSelected) {
      await sender.reply(message.chat, message.id, `已自动选择项目：${projectId}`);
    }

    const promptMessage: IncomingMessage = {
      ...message,
      text,
      images,
    };
    const submitted = await conversations.submit(promptMessage, projectId, permissions.ruleset);
    if (submitted.accepted) {
      this.#deps.quota.recordPrompt(message.userId, projectId);
      this.#deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId,
        workspaceId: null,
        action: "prompt.accepted",
        detail: {
          runId: submitted.runId,
          queued: submitted.queued,
          textLength: text.length,
          images: images.length,
          policyNames: permissions.policyNames,
        },
      });
    }
  }
}
