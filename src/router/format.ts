import type { AppConfig } from "../config/schema.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { IncomingMessage } from "../domain/message.js";
import type { WorkspaceDiffFile } from "../domain/workspace.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { AgentPort } from "../ports/agent.js";
import type { OneBotPort } from "../ports/onebot.js";
import type { WorkspaceDiff, WorkspaceStatus } from "../workspace/manager.js";

export const HELP_TEXT = [
  "OpenCode QQ Adapter 命令",
  "",
  "会话",
  "!status — 项目、工作区、会话、运行状态",
  "!new — 清除当前会话，下一条消息新建",
  "!sessions — 列出当前项目最近会话",
  "!switch ID — 恢复指定会话",
  "!stop — 中断当前任务并清空队列",
  "",
  "项目",
  "!projects — 列出可用项目",
  "!use 项目名 — 切换项目（别名 !cd）",
  "!diff — 查看会话 / 工作区改动摘要",
  "!ws — 当前工作区与锁",
  "!ws list — 列出可用工作区",
  "!ws clean — 清理过期租约（owner，可能需要 !sudo）",
  "",
  "模型",
  "!model — 查看当前模型",
  "!model list [provider] — 列出可用模型",
  "!model provider/model — 切换模型",
  "!agent — 查看当前 agent",
  "!agent list — 列出可用 agent",
  "!agent ID — 切换 agent",
  "",
  "管理",
  "!whoami — 身份、群号、可用项目",
  "!sudo 验证码 — 开启 owner 危险操作窗口",
  "!approvals — 查看待审批请求",
  "!approve ID once|always|reject — 处理审批",
  "!reject ID — 拒绝审批",
  "!audit N — 最近 N 条审计（owner/admin）",
  "!reload — 热加载配置（owner，仅私聊）",
  "!help — 显示本帮助",
  "",
  "直接发送文字或图片即可让 OpenCode 处理；危险操作会通过审批消息确认。",
].join("\n");

export async function formatStatus(
  deps: {
    config: AppConfig;
    conversations: ConversationManager;
    agent: AgentPort;
    onebot: OneBotPort;
    approvals: { pending(chatKey: string): unknown[] };
    sudo?: { enabled: boolean; remainingSeconds(actorQq: number): number };
    quota: {
      usageToday(
        actorQq: number,
        projectId: string,
      ): { actor: { prompts: number; inputTokens: number; outputTokens: number; costUsd: number } };
    };
  },
  message: IncomingMessage,
): Promise<string> {
  const status = deps.conversations.status(message.chat.chatKey);
  const conversation = status.conversation;
  const currentProjectId = conversation?.projectId ?? null;
  const project = currentProjectId ? deps.config.projects[currentProjectId] : null;
  const health = await deps.agent.health();
  const onebot = deps.onebot.status();
  const active = status.activeRun;
  const workspace =
    currentProjectId === null ? null : deps.conversations.workspaceStatus(currentProjectId);

  const lines = [
    "OpenCode QQ Adapter 状态",
    `OneBot：${onebot.connected ? "已连接" : "未连接"} (${onebot.mode})`,
    `OpenCode：${health.healthy ? "正常" : "不可用"}${health.version ? ` v${health.version}` : ""}`,
    `项目：${currentProjectId ?? "未选择"}`,
    `工作区：${project?.path ?? "-"}`,
    `工作区锁：${formatLockState(workspace, Date.now())}`,
    `会话：${conversation?.sessionId ?? "未创建"}`,
    `Agent：${conversation?.agent ?? deps.config.opencode.default_agent ?? "默认"}`,
    `模型：${conversation?.model ?? deps.config.opencode.default_model ?? "默认"}`,
    `运行：${active === null ? "空闲" : `${active.status} (${active.id})`}`,
    `队列：${status.queued}`,
    `待审批：${deps.approvals.pending(message.chat.chatKey).length}`,
  ];
  if (deps.sudo?.enabled) {
    const remaining = deps.sudo.remainingSeconds(message.userId);
    lines.push(`2FA：${remaining > 0 ? `已授权 ${remaining} 秒` : "未授权"}`);
  }
  if (currentProjectId !== null) {
    const usage = deps.quota.usageToday(message.userId, currentProjectId).actor;
    lines.push(
      `今日用量：${usage.prompts} prompts · ${usage.inputTokens + usage.outputTokens} tokens · $${usage.costUsd.toFixed(4)}`,
    );
  }
  if (health.error) {
    lines.push(`OpenCode 错误：${health.error}`);
  }
  const last = status.recentRuns[0];
  if (last !== undefined) {
    const duration =
      last.finishedAt === null
        ? null
        : Math.max(0, Math.round((last.finishedAt - last.startedAt) / 1000));
    lines.push(
      `最近运行：${last.status} (${last.id})${duration === null ? "" : ` · ${duration} 秒`}`,
    );
  }
  return lines.join("\n");
}

export function formatProjects(
  deps: {
    policy: PolicyEngine;
    conversations: ConversationManager;
  },
  message: IncomingMessage,
  role: string,
): string {
  const actor = deps.policy.actor(message.userId);
  if (actor === null) return "未授权。";
  const entries = deps.policy.projectEntries(actor, message.userId, message.chat.groupId);
  if (entries.length === 0) {
    return "没有可用项目。请联系管理员在 config.yaml 中配置 projects 与 users。";
  }
  const conversation = deps.conversations.getConversation(message.chat.chatKey);
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

export function formatWorkspace(projectId: string, status: WorkspaceStatus, now: number): string {
  const workspace = status.workspace;
  if (workspace === null) return `项目 ${projectId} 没有工作区记录。`;
  return [
    `项目：${projectId}`,
    `工作区：${workspace.path}`,
    `类型：${workspace.kind}`,
    `状态：${formatLockState(status, now)}`,
    `最近使用：${new Date(workspace.lastUsedAt).toLocaleString()}`,
  ].join("\n");
}

export function formatDiff(result: {
  workspace: WorkspaceDiff;
  session: WorkspaceDiffFile[] | null;
}): string {
  const session = result.session ?? [];
  if (session.length > 0) {
    const totals = session.reduce(
      (accumulator, file) => ({
        additions: accumulator.additions + file.additions,
        deletions: accumulator.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
    const lines = [
      `会话 diff：${session.length} 个文件 · +${totals.additions} -${totals.deletions}`,
      ...session.slice(0, 20).map((file) => {
        const marker = file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M";
        return `${marker} ${file.file} (+${file.additions} -${file.deletions})`;
      }),
    ];
    if (session.length > 20) lines.push(`… 其余 ${session.length - 20} 个文件已省略`);
    return lines.join("\n");
  }
  if (!result.workspace.isGit) {
    return "当前工作区不是 git 仓库，会话也没有 diff 记录。";
  }
  return result.workspace.text.trim().length > 0
    ? `工作区 git 改动：\n${result.workspace.text.trim()}`
    : "当前工作区没有未提交改动。";
}

function formatLockState(status: WorkspaceStatus | null, now: number): string {
  if (status === null || status.workspace === null) return "-";
  if (status.workspace.status !== "locked") return status.workspace.status;
  const remaining =
    status.leaseExpiresAt === null
      ? ""
      : `，租约 ${Math.max(0, Math.ceil((status.leaseExpiresAt - now) / 1000))} 秒`;
  return `locked by ${status.lockedByChatKey ?? "?"} / run ${status.lockedByRunId ?? "?"}${remaining}`;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
