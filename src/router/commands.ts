import { parseApprovalDecision } from "../approval/broker.js";
import { isChatProjectId } from "../chat/project.js";
import type { AuditRecord } from "../domain/audit.js";
import { formatDiff, formatProjects, formatStatus, formatWorkspace, HELP_TEXT } from "./format.js";
import type { CommandHandler, RouterDeps } from "./types.js";

/** Built-in names that plugins may not shadow. Keep this list in sync with createCommands. */
export const CORE_COMMAND_NAMES = new Set([
  "ping",
  "help",
  "whoami",
  "projects",
  "use",
  "cd",
  "new",
  "status",
  "stop",
  "diff",
  "ws",
  "workspace",
  "sudo",
  "approvals",
  "approve",
  "reject",
  "reload",
  "audit",
  "model",
  "agent",
  "sessions",
  "switch",
  "plugins",
]);

export function createCommands(deps: RouterDeps): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();

  commands.set("ping", async ({ message }) => {
    await deps.sender.reply(message.chat, message.id, "pong");
  });

  commands.set("help", async ({ message }) => {
    const pluginHelp = deps.plugins?.helpText() ?? "";
    await deps.sender.reply(
      message.chat,
      message.id,
      pluginHelp.length > 0 ? `${HELP_TEXT}\n\n${pluginHelp}` : HELP_TEXT,
    );
  });

  commands.set("plugins", async ({ message }) => {
    if (deps.plugins === undefined) {
      await deps.sender.reply(message.chat, message.id, "插件宿主未启用。");
      return;
    }
    const status = deps.plugins.status();
    if (status.plugins.length === 0) {
      await deps.sender.reply(message.chat, message.id, status.message);
      return;
    }
    const lines = [`插件（${status.loaded}/${status.total} 已加载）：`];
    for (const plugin of status.plugins) {
      const mark = plugin.status === "loaded" ? "✓" : plugin.status === "disabled" ? "-" : "✗";
      const commands =
        plugin.commands.length > 0
          ? ` · ${plugin.commands.map((name) => `!${name}`).join(", ")}`
          : "";
      const error = plugin.error !== null ? `\n  ${plugin.error.slice(0, 200)}` : "";
      lines.push(`${mark} ${plugin.id} v${plugin.version} (${plugin.status})${commands}${error}`);
    }
    await deps.sender.reply(message.chat, message.id, lines.join("\n"));
  });

  commands.set("whoami", async ({ message }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    const projects = deps.policy.availableProjects(actor).map((entry) => entry.id);
    const writable = projects.filter((project) => deps.policy.canWriteProject(actor, project));
    const chat = deps.policy.chatEntry();
    const text = [
      `QQ：${message.userId}`,
      `昵称：${message.senderName}`,
      `角色：${actor.role}`,
      ...(message.chat.type === "group" ? [`群号：${message.chat.groupId ?? "-"}`] : []),
      `会话键：${message.chat.chatKey}`,
      `可用项目：${projects.length > 0 ? projects.join(", ") : "无"}`,
      `可修改项目：${writable.length > 0 ? writable.join(", ") : "无（只能问答）"}`,
      `问答模式：${chat === null ? "未启用" : "@chat 可用"}`,
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
    const allowed = deps.policy.canUseProject(actor, projectId);
    if (!allowed.allowed || allowed.project === null) {
      await deps.sender.reply(
        message.chat,
        message.id,
        allowed.reason === "project_not_found"
          ? `项目 '${projectId}' 不存在。发送 !projects 查看可用项目。`
          : allowed.reason === "hidden_project"
            ? `项目 '${projectId}' 是插件内部项目，不能手动选择。`
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
      isChatProjectId(projectId)
        ? "已进入问答模式（@chat）：不会读写任何项目文件。"
        : `已切换到项目：${projectId}\n目录：${allowed.project.path}`,
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
      const entries = deps.policy.availableProjects(actor);
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
        "用法：!approve ID once\n     !approve ID always\n     !approve ID reject\n也可以直接引用审批消息回复 1/2/3。",
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

  commands.set("reload", async ({ message }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    if (actor.role !== "owner" && actor.role !== "admin") {
      await deps.sender.reply(message.chat, message.id, "只有 owner/admin 可以热加载配置。");
      return;
    }
    if (message.chat.type !== "private") {
      await deps.sender.reply(message.chat, message.id, "为安全起见，!reload 只允许私聊使用。");
      return;
    }
    if (deps.reloadConfig === undefined) {
      await deps.sender.reply(message.chat, message.id, "当前运行方式不支持热加载。");
      return;
    }
    const result = await deps.reloadConfig();
    if (!result.ok) {
      await deps.sender.reply(
        message.chat,
        message.id,
        `配置热加载失败，旧配置继续生效：\n${result.error ?? "未知错误"}`,
      );
      return;
    }
    const lines = ["配置已热加载。"];
    lines.push(`已生效：${result.applied.length > 0 ? result.applied.join(", ") : "无变化"}`);
    if (result.restartRequired.length > 0) {
      lines.push(`需要重启：${result.restartRequired.join(", ")}`);
    }
    if (result.warnings.length > 0) {
      lines.push(`警告：${result.warnings.slice(0, 5).join("；")}`);
    }
    await deps.sender.reply(message.chat, message.id, lines.join("\n"));
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

  commands.set("model", async ({ message, args }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "list") {
      const directory = workspaceDirectory(deps, message.chat.chatKey);
      let models: Awaited<ReturnType<typeof deps.agent.listModels>>;
      try {
        models = await deps.agent.listModels(directory ?? undefined);
      } catch (error) {
        await deps.sender.reply(
          message.chat,
          message.id,
          `读取模型列表失败：${errorMessage(error)}`,
        );
        return;
      }
      const provider = args[1];
      const visible = models
        .filter((model) => model.enabled)
        .filter((model) => provider === undefined || model.providerID === provider)
        .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
      if (visible.length === 0) {
        await deps.sender.reply(
          message.chat,
          message.id,
          provider
            ? `provider '${provider}' 没有可用模型。`
            : "OpenCode 没有返回可用模型；请先配置 provider。",
        );
        return;
      }
      const current = conversation?.model ?? deps.config.opencode.default_model;
      const lines = [`可用模型（${visible.length}）：`];
      for (const model of visible.slice(0, 30)) {
        const marker = model.id === current ? "*" : "-";
        const variants =
          model.variants.length > 0 ? ` (variants: ${model.variants.join(", ")})` : "";
        lines.push(`${marker} ${model.id} — ${model.name}${variants}`);
      }
      if (visible.length > 30) lines.push(`… 其余 ${visible.length - 30} 个已省略`);
      lines.push("使用 !model provider/model 切换。");
      await deps.sender.reply(message.chat, message.id, lines.join("\n"));
      return;
    }

    if (args.length > 0) {
      const model = args[0] ?? "";
      if (!model.includes("/")) {
        await deps.sender.reply(message.chat, message.id, "用法：!model provider/model");
        return;
      }
      const result = await deps.conversations.setModel(message.chat.chatKey, model);
      if (!result.ok) {
        await deps.sender.reply(message.chat, message.id, result.reason ?? "切换模型失败。");
        return;
      }
      deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId: conversation?.projectId ?? null,
        workspaceId: conversation?.workspaceId ?? null,
        action: "conversation.model_changed",
        detail: { model },
      });
      await deps.sender.reply(message.chat, message.id, `已切换模型：${model}`);
      return;
    }

    const project = conversation ? deps.config.projects[conversation.projectId] : undefined;
    const current =
      conversation?.model ??
      project?.model ??
      deps.config.opencode.default_model ??
      "OpenCode 默认";
    await deps.sender.reply(
      message.chat,
      message.id,
      `当前模型：${current}\n使用 !model list 查看可用模型，!model provider/model 切换。`,
    );
  });

  commands.set("agent", async ({ message, args }) => {
    const actor = deps.policy.actor(message.userId);
    if (actor === null) return;
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    if ((args[0] ?? "").toLowerCase() === "list") {
      const directory = workspaceDirectory(deps, message.chat.chatKey);
      let agents: Awaited<ReturnType<typeof deps.agent.listAgents>>;
      try {
        agents = await deps.agent.listAgents(directory ?? undefined);
      } catch (error) {
        await deps.sender.reply(
          message.chat,
          message.id,
          `读取 agent 列表失败：${errorMessage(error)}`,
        );
        return;
      }
      const visible = agents
        .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (visible.length === 0) {
        await deps.sender.reply(message.chat, message.id, "OpenCode 没有返回可用 agent。");
        return;
      }
      const current = conversation?.agent ?? deps.config.opencode.default_agent;
      const lines = ["可用 agent："];
      for (const agent of visible) {
        const marker = agent.id === current ? "*" : "-";
        const description = agent.description ? ` — ${agent.description}` : "";
        lines.push(`${marker} ${agent.id}${description}`);
      }
      lines.push("使用 !agent ID 切换。");
      await deps.sender.reply(message.chat, message.id, lines.join("\n"));
      return;
    }

    if (args.length > 0) {
      const agent = args[0] ?? "";
      const result = await deps.conversations.setAgent(message.chat.chatKey, agent);
      if (!result.ok) {
        await deps.sender.reply(message.chat, message.id, result.reason ?? "切换 agent 失败。");
        return;
      }
      deps.audit.record({
        ts: Date.now(),
        actorQq: message.userId,
        chatKey: message.chat.chatKey,
        projectId: conversation?.projectId ?? null,
        workspaceId: conversation?.workspaceId ?? null,
        action: "conversation.agent_changed",
        detail: { agent },
      });
      await deps.sender.reply(message.chat, message.id, `已切换 agent：${agent}`);
      return;
    }

    const project = conversation ? deps.config.projects[conversation.projectId] : undefined;
    const current =
      conversation?.agent ??
      project?.agent ??
      deps.config.opencode.default_agent ??
      "OpenCode 默认";
    await deps.sender.reply(
      message.chat,
      message.id,
      `当前 agent：${current}\n使用 !agent list 查看可用 agent，!agent ID 切换。`,
    );
  });

  commands.set("sessions", async ({ message }) => {
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    if (conversation === null) {
      await deps.sender.reply(message.chat, message.id, "还没有选择项目。请先发送 !use <项目>。");
      return;
    }
    const directory = workspaceDirectory(deps, message.chat.chatKey);
    if (directory === null) {
      await deps.sender.reply(message.chat, message.id, "当前项目目录不可用。");
      return;
    }
    let sessions: Awaited<ReturnType<typeof deps.agent.listSessions>>;
    try {
      sessions = await deps.agent.listSessions(directory, 20);
    } catch (error) {
      await deps.sender.reply(message.chat, message.id, `读取会话失败：${errorMessage(error)}`);
      return;
    }
    if (sessions.length === 0) {
      await deps.sender.reply(message.chat, message.id, "当前项目还没有 OpenCode 会话。");
      return;
    }
    const lines = [`项目 ${conversation.projectId} 的最近会话：`];
    for (const session of sessions) {
      const marker = session.id === conversation.sessionId ? "*" : "-";
      const title = session.title ?? "(untitled)";
      const time = session.updated ?? session.created;
      const when = time === null ? "-" : new Date(time).toLocaleString();
      lines.push(`${marker} ${session.id.slice(0, 12)} … ${title} · ${when}`);
    }
    lines.push("使用 !switch <会话 ID 前缀> 恢复。");
    await deps.sender.reply(message.chat, message.id, lines.join("\n"));
  });

  commands.set("switch", async ({ message, args }) => {
    const conversation = deps.conversations.getConversation(message.chat.chatKey);
    if (conversation === null) {
      await deps.sender.reply(message.chat, message.id, "还没有选择项目。请先发送 !use <项目>。");
      return;
    }
    const prefix = args[0] ?? "";
    if (prefix.length < 4) {
      await deps.sender.reply(message.chat, message.id, "用法：!switch <至少 4 位会话 ID 前缀>");
      return;
    }
    const directory = workspaceDirectory(deps, message.chat.chatKey);
    if (directory === null) {
      await deps.sender.reply(message.chat, message.id, "当前项目目录不可用。");
      return;
    }
    const sessions = await deps.agent.listSessions(directory, 50).catch(() => []);
    const matches = sessions.filter((session) => session.id.startsWith(prefix));
    if (matches.length === 0) {
      await deps.sender.reply(message.chat, message.id, "找不到匹配的会话，请先发送 !sessions。");
      return;
    }
    if (matches.length > 1) {
      await deps.sender.reply(message.chat, message.id, "前缀匹配到多个会话，请提供更长的 ID。");
      return;
    }
    const session = matches[0];
    if (session === undefined) return;
    const result = deps.conversations.switchSession(message.chat.chatKey, session);
    if (!result.ok) {
      await deps.sender.reply(message.chat, message.id, result.reason ?? "切换会话失败。");
      return;
    }
    deps.audit.record({
      ts: Date.now(),
      actorQq: message.userId,
      chatKey: message.chat.chatKey,
      projectId: conversation.projectId,
      workspaceId: conversation.workspaceId,
      action: "conversation.session_switched",
      detail: { sessionId: session.id },
    });
    await deps.sender.reply(
      message.chat,
      message.id,
      `已切换会话：${session.id.slice(0, 12)}…\n${session.title ?? "(untitled)"}`,
    );
  });

  return commands;
}

function workspaceDirectory(deps: RouterDeps, chatKey: string): string | null {
  const conversation = deps.conversations.getConversation(chatKey);
  if (conversation === null) return null;
  try {
    return deps.workspaces.pathFor(conversation.projectId);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
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
