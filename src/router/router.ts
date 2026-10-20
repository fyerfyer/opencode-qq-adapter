import type { Logger } from "pino";
import type { AppConfig } from "../config/schema.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { IncomingMessage } from "../domain/message.js";
import { parseCommand } from "../domain/message.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { AgentPort } from "../ports/agent.js";
import type { OneBotPort } from "../ports/onebot.js";
import type { MessageSender } from "../qq/sender.js";

interface CommandContext {
  message: IncomingMessage;
  args: string[];
  rawArgs: string;
}

type CommandHandler = (context: CommandContext) => Promise<void> | void;

const HELP_TEXT = [
  "OpenCode QQ Adapter 命令：",
  "!ping — 连通性检查",
  "!status — 查看项目、会话、运行状态",
  "!stop — 中断当前任务并清空队列",
  "!projects — 列出可用项目",
  "!use <项目> — 切换项目（别名 !cd）",
  "!new — 为当前项目创建新会话",
  "!model — 查看当前模型",
  "!agent — 查看当前 agent",
  "!whoami — 查看身份与可用项目",
  "!help — 显示本帮助",
  "",
  "直接发送文字即可让 OpenCode 处理；图片输入计划在 M4 支持。",
].join("\n");

export class MessageRouter {
  readonly #config: AppConfig;
  readonly #policy: PolicyEngine;
  readonly #conversations: ConversationManager;
  readonly #sender: MessageSender;
  readonly #agent: AgentPort;
  readonly #onebot: OneBotPort;
  readonly #logger: Logger;
  readonly #commands = new Map<string, CommandHandler>();

  constructor(deps: {
    config: AppConfig;
    policy: PolicyEngine;
    conversations: ConversationManager;
    sender: MessageSender;
    agent: AgentPort;
    onebot: OneBotPort;
    logger: Logger;
  }) {
    this.#config = deps.config;
    this.#policy = deps.policy;
    this.#conversations = deps.conversations;
    this.#sender = deps.sender;
    this.#agent = deps.agent;
    this.#onebot = deps.onebot;
    this.#logger = deps.logger;
    this.#registerCommands();
  }

  async handle(message: IncomingMessage): Promise<void> {
    const decision = this.#policy.authorize(message);
    if (!decision.allowed || decision.actor === null) {
      this.#logger.debug(
        { qq: message.userId, chatKey: message.chat.chatKey, reason: decision.reason },
        "Ignoring message from unauthorized actor",
      );
      return;
    }

    const command = parseCommand(message.text);
    if (message.chat.type === "group") {
      if (
        command === undefined &&
        this.#policy.isGroupMentionRequired(message.chat.groupId) &&
        !message.mentionsBot
      ) {
        return;
      }
    }

    if (command !== undefined) {
      await this.#dispatch(command.name, {
        message,
        args: command.args,
        rawArgs: command.rawArgs,
      });
      return;
    }

    await this.#handlePrompt(message);
  }

  #registerCommands(): void {
    this.#commands.set("ping", async ({ message }) => {
      await this.#sender.reply(message.chat, message.id, "pong");
    });
    this.#commands.set("help", async ({ message }) => {
      await this.#sender.reply(message.chat, message.id, HELP_TEXT);
    });
    this.#commands.set("whoami", async ({ message }) => {
      const actor = this.#policy.actor(message.userId);
      if (actor === null) return;
      const projects = this.#policy
        .availableProjects(actor, message.userId, message.chat.groupId)
        .map((entry) => entry.id);
      const text = [
        `QQ：${message.userId}`,
        `昵称：${message.senderName}`,
        `角色：${actor.role}`,
        `可用项目：${projects.length > 0 ? projects.join(", ") : "无"}`,
      ].join("\n");
      await this.#sender.reply(message.chat, message.id, text);
    });
    this.#commands.set("projects", async ({ message }) => {
      const actor = this.#policy.actor(message.userId);
      if (actor === null) return;
      await this.#sender.reply(message.chat, message.id, this.#projectsText(message, actor.role));
    });
    const useProject: CommandHandler = async ({ message, args }) => {
      const actor = this.#policy.actor(message.userId);
      if (actor === null) return;
      if (args.length === 0) {
        await this.#sender.reply(message.chat, message.id, this.#projectsText(message, actor.role));
        return;
      }
      const projectId = args[0] ?? "";
      const allowed = this.#policy.canUseProject(
        actor,
        message.userId,
        projectId,
        message.chat.groupId,
      );
      if (!allowed.allowed || allowed.project === null) {
        await this.#sender.reply(
          message.chat,
          message.id,
          allowed.reason === "project_not_found"
            ? `项目 '${projectId}' 不存在。发送 !projects 查看可用项目。`
            : `你没有权限使用项目 '${projectId}'。`,
        );
        return;
      }
      const switched = this.#conversations.setProject(
        message.chat.chatKey,
        projectId,
        message.userId,
      );
      if (!switched.ok) {
        await this.#sender.reply(message.chat, message.id, switched.reason ?? "切换失败。");
        return;
      }
      await this.#sender.reply(
        message.chat,
        message.id,
        `已切换到项目：${projectId}\n目录：${allowed.project.path}`,
      );
    };
    this.#commands.set("use", useProject);
    this.#commands.set("cd", useProject);
    this.#commands.set("new", async ({ message }) => {
      const result = this.#conversations.resetSession(message.chat.chatKey);
      await this.#sender.reply(
        message.chat,
        message.id,
        result.ok ? "已清除当前会话，下一条消息将创建新会话。" : (result.reason ?? "操作失败。"),
      );
    });
    this.#commands.set("status", async ({ message }) => {
      await this.#status(message);
    });
    this.#commands.set("stop", async ({ message }) => {
      const result = await this.#conversations.stop(message.chat.chatKey);
      if (!result.stopped && result.queuedCleared === 0) {
        await this.#sender.reply(message.chat, message.id, "当前没有运行中的任务。");
        return;
      }
      const parts: string[] = [];
      if (result.stopped) parts.push("已请求中断当前任务。");
      if (result.queuedCleared > 0) parts.push(`已清空 ${result.queuedCleared} 条排队任务。`);
      await this.#sender.reply(message.chat, message.id, parts.join("\n"));
    });
    this.#commands.set("model", async ({ message }) => {
      const conversation = this.#conversations.getConversation(message.chat.chatKey);
      await this.#sender.reply(
        message.chat,
        message.id,
        `当前模型：${conversation?.model ?? this.#config.opencode.default_model ?? "OpenCode 默认"}`,
      );
    });
    this.#commands.set("agent", async ({ message }) => {
      const conversation = this.#conversations.getConversation(message.chat.chatKey);
      await this.#sender.reply(
        message.chat,
        message.id,
        `当前 agent：${conversation?.agent ?? this.#config.opencode.default_agent ?? "OpenCode 默认"}`,
      );
    });
  }

  async #dispatch(name: string, context: CommandContext): Promise<void> {
    const handler = this.#commands.get(name);
    if (handler === undefined) {
      await this.#sender.reply(
        context.message.chat,
        context.message.id,
        `未知命令：!${name}\n发送 !help 查看可用命令。`,
      );
      return;
    }
    try {
      await handler(context);
    } catch (error) {
      this.#logger.error({ err: error, command: name }, "Command failed");
      await this.#sender
        .reply(context.message.chat, context.message.id, `命令执行失败：${errorMessage(error)}`)
        .catch(() => undefined);
    }
  }

  async #handlePrompt(message: IncomingMessage): Promise<void> {
    const actor = this.#policy.actor(message.userId);
    if (actor === null) return;

    if (message.text.length === 0) {
      if (message.images.length > 0) {
        await this.#sender.reply(
          message.chat,
          message.id,
          "当前版本暂不支持图片输入（计划在 M4 支持）。请先发送文字。",
        );
      }
      return;
    }
    if (message.text.length > this.#config.security.max_prompt_chars) {
      await this.#sender.reply(
        message.chat,
        message.id,
        `消息过长（${message.text.length} 字），上限为 ${this.#config.security.max_prompt_chars} 字。`,
      );
      return;
    }

    let projectId: string | null = null;
    const conversation = this.#conversations.getConversation(message.chat.chatKey);
    if (conversation !== null) {
      const allowed = this.#policy.canUseProject(
        actor,
        message.userId,
        conversation.projectId,
        message.chat.groupId,
      );
      if (allowed.allowed) projectId = conversation.projectId;
    }

    let autoSelected = false;
    if (projectId === null) {
      const fallback = this.#policy.defaultProject(actor, message.userId, message.chat.groupId);
      if (fallback === null) {
        await this.#sender.reply(
          message.chat,
          message.id,
          "还没有选择项目，或你有多个可用项目。请先发送 !projects 查看，再发送 !use <项目>。",
        );
        return;
      }
      projectId = fallback.id;
      autoSelected = conversation === null;
    }

    if (message.images.length > 0) {
      await this.#sender.reply(
        message.chat,
        message.id,
        "提示：当前版本暂不处理图片附件（计划在 M4 支持），本条消息仅发送文字部分。",
      );
    }

    if (autoSelected) {
      await this.#sender.reply(message.chat, message.id, `已自动选择项目：${projectId}`);
    }

    await this.#conversations.submit(message, projectId);
  }

  async #status(message: IncomingMessage): Promise<void> {
    const actor = this.#policy.actor(message.userId);
    if (actor === null) return;
    const status = this.#conversations.status(message.chat.chatKey);
    const conversation = status.conversation;
    const currentProjectId = conversation?.projectId ?? null;
    const project = currentProjectId ? this.#config.projects[currentProjectId] : null;
    const health = await this.#agent.health();
    const onebot = this.#onebot.status();
    const active = status.activeRun;

    const lines = [
      "OpenCode QQ Adapter 状态",
      `OneBot：${onebot.connected ? "已连接" : "未连接"} (${onebot.mode})`,
      `OpenCode：${health.healthy ? "正常" : "不可用"}${
        health.version ? ` v${health.version}` : ""
      }`,
      `项目：${currentProjectId ?? "未选择"}`,
      `工作区：${project?.path ?? "-"}`,
      `会话：${conversation?.sessionId ?? "未创建"}`,
      `Agent：${conversation?.agent ?? this.#config.opencode.default_agent ?? "默认"}`,
      `模型：${conversation?.model ?? this.#config.opencode.default_model ?? "默认"}`,
      `运行：${active === null ? "空闲" : `${active.status} (${active.id})`}`,
      `队列：${status.queued}`,
    ];
    if (health.error) {
      lines.push(`OpenCode 错误：${health.error}`);
    }
    const last = status.recentRuns[0];
    if (last !== undefined) {
      lines.push(`最近运行：${last.status} (${last.id})`);
    }
    await this.#sender.reply(message.chat, message.id, lines.join("\n"));
  }

  #projectsText(message: IncomingMessage, role: string): string {
    const actor = this.#policy.actor(message.userId);
    if (actor === null) return "未授权。";
    const entries = this.#policy.projectEntries(actor, message.userId, message.chat.groupId);
    if (entries.length === 0) {
      return "没有可用项目。请联系管理员在 config.yaml 中配置 projects 与 users。";
    }
    const conversation = this.#conversations.getConversation(message.chat.chatKey);
    const current = conversation?.projectId ?? null;
    const lines = [`角色：${role}`, "可用项目："];
    for (const entry of entries) {
      const marker = entry.id === current ? "*" : "-";
      const description = entry.project.description ? ` — ${entry.project.description}` : "";
      lines.push(`${marker} ${entry.id}${description}`);
      lines.push(`  ${entry.project.path}`);
    }
    return lines.join("\n");
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
