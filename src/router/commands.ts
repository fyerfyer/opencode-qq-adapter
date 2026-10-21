import { parseApprovalDecision } from "../approval/broker.js";
import type { AuditRecord } from "../domain/audit.js";
import { formatDiff, formatProjects, formatStatus, formatWorkspace, HELP_TEXT } from "./format.js";
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
    deps.audit.record({
      ts: Date.now(),
      actorQq: message.userId,
      chatKey: message.chat.chatKey,
      projectId,
      workspaceId: null,
      action: "project.selected",
      detail: { path: allowed.project.path },
    });
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
    if (result.ok) {
      deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId: deps.conversations.getConversation(message.chat.chatKey)?.projectId ?? null,
        workspaceId: null,
        action: "session.reset",
        detail: {},
      });
    }
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
    const rejected = await deps.approvals.rejectChat(message.chat.chatKey, "stop_command");
    if (!result.stopped && result.queuedCleared === 0 && rejected === 0) {
      await deps.sender.reply(message.chat, message.id, "当前没有运行中的任务。");
      return;
    }
    const parts: string[] = [];
    if (result.stopped) parts.push("已请求中断当前任务。");
    if (result.queuedCleared > 0) parts.push(`已清空 ${result.queuedCleared} 条排队任务。`);
    if (rejected > 0) parts.push(`已拒绝 ${rejected} 个待审批请求。`);
    deps.audit.record({
      ts: Date.now(),
      actorQq: message.userId,
      chatKey: message.chat.chatKey,
      projectId: deps.conversations.getConversation(message.chat.chatKey)?.projectId ?? null,
      workspaceId: null,
      action: "run.stop_requested",
      detail: { stopped: result.stopped, queuedCleared: result.queuedCleared, rejected },
    });
    await deps.sender.reply(message.chat, message.id, parts.join("\n"));
  });

  commands.set("diff", async ({ message }) => {
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    if (conversation === null) {
      await deps.sender.reply(message.chat, message.id, "还没有选择项目。请先发送 !use <项目>。");
      return;
    }
    const result = await deps.conversations.diff(conversation.projectId, conversation.sessionId);
    deps.audit.record({
      ts: Date.now(),
      actorQq: message.userId,
      chatKey: message.chat.chatKey,
      projectId: conversation.projectId,
      workspaceId: conversation.workspaceId,
      action: "workspace.diff",
      detail: {
        files: result.session?.length ?? 0,
        git: result.workspace.isGit,
      },
    });
    await deps.sender.reply(message.chat, message.id, formatDiff(result));
  });

  const workspaceCommand: CommandHandler = async ({ message, args }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "list") {
      const entries = deps.policy.availableProjects(actor, message.userId, message.chat.groupId);
      if (entries.length === 0) {
        await deps.sender.reply(message.chat, message.id, "没有可用项目。");
        return;
      }
      const lines = ["工作区："];
      for (const entry of entries) {
        const status = deps.conversations.workspaceStatus(entry.id);
        const state =
          status.workspace?.status === "locked"
            ? `locked by ${status.lockedByChatKey ?? "?"}`
            : (status.workspace?.status ?? "idle");
        lines.push(`- ${entry.id}: ${entry.project.path} (${state})`);
      }
      await deps.sender.reply(message.chat, message.id, lines.join("\n"));
      return;
    }
    if (sub === "clean") {
      if (actor.role !== "owner") {
        await deps.sender.reply(message.chat, message.id, "只有 owner 可以清理工作区。");
        return;
      }
      if (!deps.sudo.isActive(message.userId)) {
        await deps.sender.reply(
          message.chat,
          message.id,
          `该操作需要先发送 !sudo <6位动态验证码> 授权（${deps.sudo.windowSeconds} 秒内有效）。`,
        );
        return;
      }
      const released = deps.conversations.cleanWorkspaces();
      deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId: deps.conversations.getConversation(message.chat.chatKey)?.projectId ?? null,
        workspaceId: null,
        action: "workspace.cleanup",
        detail: { released },
      });
      await deps.sender.reply(
        message.chat,
        message.id,
        released > 0 ? `已释放 ${released} 个过期工作区锁。` : "没有需要清理的过期锁。",
      );
      return;
    }

    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    if (conversation === null) {
      await deps.sender.reply(message.chat, message.id, "还没有选择项目。请先发送 !use <项目>。");
      return;
    }
    const status = deps.conversations.workspaceStatus(conversation.projectId);
    await deps.sender.reply(
      message.chat,
      message.id,
      formatWorkspace(conversation.projectId, status, Date.now()),
    );
  };
  commands.set("ws", workspaceCommand);
  commands.set("workspace", workspaceCommand);

  commands.set("sudo", async ({ message, args }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    if (actor.role !== "owner") {
      await deps.sender.reply(message.chat, message.id, "只有 owner 可以使用 !sudo。");
      return;
    }
    if (message.chat.type !== "private") {
      await deps.sender.reply(message.chat, message.id, "为安全起见，!sudo 只允许私聊使用。");
      return;
    }
    if (!deps.sudo.enabled) {
      await deps.sender.reply(message.chat, message.id, "2FA 未启用，无需 sudo 授权。");
      return;
    }
    const code = args[0] ?? "";
    if (!deps.sudo.verify(message.userId, code)) {
      deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId: null,
        workspaceId: null,
        action: "sudo.denied",
        detail: {},
      });
      await deps.sender.reply(message.chat, message.id, "验证码无效或已过期。");
      return;
    }
    deps.audit.record({
      ts: Date.now(),
      actorQq: message.userId,
      chatKey: message.chat.chatKey,
      projectId: null,
      workspaceId: null,
      action: "sudo.granted",
      detail: { windowSeconds: deps.sudo.windowSeconds },
    });
    await deps.sender.reply(
      message.chat,
      message.id,
      `已授权 ${deps.sudo.windowSeconds} 秒危险操作窗口。`,
    );
  });

  commands.set("approvals", async ({ message }) => {
    await deps.sender.reply(
      message.chat,
      message.id,
      deps.approvals.pendingList(message.chat.chatKey),
    );
  });

  commands.set("approve", async ({ message, args }) => {
    const id = args[0] ?? "";
    const decision = parseApprovalDecision(args[1] ?? "");
    if (id.length === 0 || decision === null) {
      await deps.sender.reply(
        message.chat,
        message.id,
        "用法：!approve ID once|always|reject\n也可以直接引用审批消息回复 1/2/3。",
      );
      return;
    }
    await deps.approvals.resolve(message, id, decision);
  });

  commands.set("reject", async ({ message, args }) => {
    const id = args[0] ?? "";
    if (id.length === 0) {
      await deps.sender.reply(message.chat, message.id, "用法：!reject ID");
      return;
    }
    await deps.approvals.resolve(message, id, "reject");
  });

  commands.set("audit", async ({ message, args }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    if (actor.role !== "owner" && actor.role !== "admin") {
      await deps.sender.reply(message.chat, message.id, "只有 owner/admin 可以查看审计日志。");
      return;
    }
    const requested = Number(args[0] ?? "10");
    const limit = Number.isFinite(requested) ? Math.min(Math.max(1, requested), 50) : 10;
    const records = deps.audit.listRecent(limit);
    await deps.sender.reply(message.chat, message.id, formatAudit(records));
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

function formatAudit(records: AuditRecord[]): string {
  if (records.length === 0) return "审计日志为空。";
  return [
    `最近 ${records.length} 条审计记录：`,
    ...records.map((record) => {
      const time = new Date(record.ts).toLocaleString();
      const actor = record.actorQq ?? "-";
      const project = record.projectId ?? "-";
      const detail = summarizeDetail(record.detail);
      return `${time} · ${record.action} · QQ ${actor} · ${project}${detail ? ` · ${detail}` : ""}`;
    }),
  ].join("\n");
}

function summarizeDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail !== "object") return String(detail).slice(0, 120);
  const entries = Object.entries(detail as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join(", ").slice(0, 180);
}
