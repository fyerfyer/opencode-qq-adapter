import type { AppConfig } from "../config/schema.js";
import type { ConversationManager } from "../conversation/manager.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { AgentPort } from "../ports/agent.js";
import type { OneBotPort } from "../ports/onebot.js";

export const HELP_TEXT = [
  "OpenCode QQ Adapter 命令：",
  "!ping — 连通性检查",
  "!status — 查看项目、会话、运行状态",
  "!stop — 中断当前任务并清空队列",
  "!projects — 列出可用项目",
  "!use 项目名 — 切换项目（别名 !cd）",
  "!new — 为当前项目创建新会话",
  "!model — 查看当前模型",
  "!agent — 查看当前 agent",
  "!whoami — 查看身份与可用项目",
  "!approvals — 查看待审批请求",
  "!approve ID once|always|reject — 处理审批",
  "!reject ID — 拒绝审批",
  "!audit N — 查看最近 N 条审计记录（owner/admin）",
  "!help — 显示本帮助",
  "",
  "直接发送文字即可让 OpenCode 处理；危险操作会通过审批消息确认。",
  "图片输入计划在 M4 支持。",
].join("\n");

export async function formatStatus(
  deps: {
    config: AppConfig;
    conversations: ConversationManager;
    agent: AgentPort;
    onebot: OneBotPort;
    approvals: { pending(chatKey: string): unknown[] };
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

  const lines = [
    "OpenCode QQ Adapter 状态",
    `OneBot：${onebot.connected ? "已连接" : "未连接"} (${onebot.mode})`,
    `OpenCode：${health.healthy ? "正常" : "不可用"}${health.version ? ` v${health.version}` : ""}`,
    `项目：${currentProjectId ?? "未选择"}`,
    `工作区：${project?.path ?? "-"}`,
    `会话：${conversation?.sessionId ?? "未创建"}`,
    `Agent：${conversation?.agent ?? deps.config.opencode.default_agent ?? "默认"}`,
    `模型：${conversation?.model ?? deps.config.opencode.default_model ?? "默认"}`,
    `运行：${active === null ? "空闲" : `${active.status} (${active.id})`}`,
    `队列：${status.queued}`,
    `待审批：${deps.approvals.pending(message.chat.chatKey).length}`,
  ];
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
    lines.push(`最近运行：${last.status} (${last.id})`);
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

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
