import { formatProjects, formatStatus, HELP_TEXT } from "./format.js";
import type { CommandHandler, RouterDeps } from "./types.js";

export function createCommands(deps: RouterDeps): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();

  commands.set("ping", async ({ message }) => {
    await deps.sender.reply(message.chat, message.id, "pong");
  });

  commands.set("help", async ({ message }) => {
    await deps.sender.reply(message.chat, message.id, HELP_TEXT);
  });

  commands.set("whoami", async ({ message }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    const projects = deps.policy
      .availableProjects(actor, message.userId, message.chat.groupId)
      .map((entry) => entry.id);
    const text = [
      `QQ：${message.userId}`,
      `昵称：${message.senderName}`,
      `角色：${actor.role}`,
      `可用项目：${projects.length > 0 ? projects.join(", ") : "无"}`,
    ].join("\n");
    await deps.sender.reply(message.chat, message.id, text);
  });

  commands.set("projects", async ({ message }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    await deps.sender.reply(message.chat, message.id, formatProjects(deps, message, actor.role));
  });

  const useProject: CommandHandler = async ({ message, args }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    if (args.length === 0) {
      await deps.sender.reply(message.chat, message.id, formatProjects(deps, message, actor.role));
      return;
    }
    const projectId = args[0] ?? "";
    const allowed = deps.policy.canUseProject(
      actor,
      message.userId,
      projectId,
      message.chat.groupId,
    );
    if (!allowed.allowed || allowed.project === null) {
      await deps.sender.reply(
        message.chat,
        message.id,
        allowed.reason === "project_not_found"
          ? `项目 '${projectId}' 不存在。发送 !projects 查看可用项目。`
          : `你没有权限使用项目 '${projectId}'。`,
      );
      return;
    }
    const switched = deps.conversations.setProject(message.chat.chatKey, projectId, message.userId);
    if (!switched.ok) {
      await deps.sender.reply(message.chat, message.id, switched.reason ?? "切换失败。");
      return;
    }
    await deps.sender.reply(
      message.chat,
      message.id,
      `已切换到项目：${projectId}\n目录：${allowed.project.path}`,
    );
  };
  commands.set("use", useProject);
  commands.set("cd", useProject);

  commands.set("new", async ({ message }) => {
    const result = deps.conversations.resetSession(message.chat.chatKey);
    await deps.sender.reply(
      message.chat,
      message.id,
      result.ok ? "已清除当前会话，下一条消息将创建新会话。" : (result.reason ?? "操作失败。"),
    );
  });

  commands.set("status", async ({ message }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    await deps.sender.reply(message.chat, message.id, await formatStatus(deps, message));
  });

  commands.set("stop", async ({ message }) => {
    const result = await deps.conversations.stop(message.chat.chatKey);
    if (!result.stopped && result.queuedCleared === 0) {
      await deps.sender.reply(message.chat, message.id, "当前没有运行中的任务。");
      return;
    }
    const parts: string[] = [];
    if (result.stopped) parts.push("已请求中断当前任务。");
    if (result.queuedCleared > 0) parts.push(`已清空 ${result.queuedCleared} 条排队任务。`);
    await deps.sender.reply(message.chat, message.id, parts.join("\n"));
  });

  commands.set("model", async ({ message }) => {
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    await deps.sender.reply(
      message.chat,
      message.id,
      `当前模型：${conversation?.model ?? deps.config.opencode.default_model ?? "OpenCode 默认"}`,
    );
  });

  commands.set("agent", async ({ message }) => {
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    await deps.sender.reply(
      message.chat,
      message.id,
      `当前 agent：${conversation?.agent ?? deps.config.opencode.default_agent ?? "OpenCode 默认"}`,
    );
  });

  return commands;
}
