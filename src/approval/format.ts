import type { ApprovalRecord } from "../domain/approval.js";

const MAX_RESOURCE_CHARS = 800;

export function formatApprovalPrompt(approval: ApprovalRecord, timeoutSec: number): string {
  const resources = approval.resources
    .map((resource) => `- ${truncate(resource, MAX_RESOURCE_CHARS)}`)
    .join("\n");
  const lines = [
    `⚠️ 需要审批 #${approval.shortId}`,
    `操作：${approval.action}`,
    `发起人：QQ ${approval.actorQq}`,
    resources.length > 0 ? `资源：\n${resources}` : "资源：-",
  ];
  if (approval.message !== null && approval.message.trim().length > 0) {
    lines.push(`说明：${truncate(approval.message, 500)}`);
  }
  lines.push(
    "",
    "回复 1 允许一次 / 2 本会话总是允许 / 3 拒绝",
    "或发送以下任一命令：",
    `!approve ${approval.shortId} once`,
    `!approve ${approval.shortId} always`,
    `!approve ${approval.shortId} reject`,
    `超时：${timeoutSec} 秒后自动拒绝`,
  );
  return lines.join("\n");
}

export function formatApprovalList(approvals: ApprovalRecord[], now = Date.now()): string {
  if (approvals.length === 0) return "当前没有待审批请求。";
  const lines = ["待审批请求："];
  for (const approval of approvals) {
    const remaining = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
    lines.push(
      `#${approval.shortId} · ${approval.action} · ${truncate(approval.resources.join("; "), 160)}`,
      `  剩余 ${remaining}s · 发起人 ${approval.actorQq}`,
    );
  }
  lines.push("", "发送 !approve <id> once（或 always / reject）进行处理。");
  return lines.join("\n");
}

export function formatResolvedApproval(
  approval: ApprovalRecord,
  decision: "once" | "always" | "reject",
): string {
  if (decision === "reject") return `已拒绝审批 #${approval.shortId}。`;
  const suffix = decision === "always" ? "（本会话总是允许）" : "（仅本次）";
  return `已批准审批 #${approval.shortId} ${suffix}。`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
