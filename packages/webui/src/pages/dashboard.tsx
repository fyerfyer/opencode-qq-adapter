import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { Overview } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { StatusDot } from "@/components/common/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatCurrency, formatDate, formatDuration, formatNumber, shortId } from "@/lib/utils";

export function DashboardPage() {
  const { data, error, loading, refresh } = useApiQuery<Overview>("/overview", {
    intervalMs: 15_000,
  });

  if (loading && data === null) return <LoadingState rows={8} />;
  if (error !== null && data === null) {
    return (
      <ErrorState
        message={error}
        action={
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw /> 重试
          </Button>
        }
      />
    );
  }
  if (data === null) return null;

  const usage = data.usageToday.reduce(
    (total, row) => ({
      prompts: total.prompts + row.prompts,
      tokens: total.tokens + row.inputTokens + row.outputTokens,
      cost: total.cost + row.costUsd,
    }),
    { prompts: 0, tokens: 0, cost: 0 },
  );
  const runs = dedupeRuns([...data.activeRuns, ...data.recentRuns]).slice(0, 10);

  return (
    <div className="space-y-6">
      <PageHeader
        title="概览"
        description="Bridge、OpenCode 与 QQ 的实时状态，今天的运行和用量。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw /> 刷新
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Bridge"
          value={
            data.status.status === "ok"
              ? "正常"
              : data.status.status === "degraded"
                ? "降级"
                : "异常"
          }
          hint={`v${data.version} · 运行 ${formatDuration(data.status.uptimeSec)}`}
          icon={<ServerCog />}
        />
        <StatCard
          label="OneBot"
          value={data.status.onebot.connected ? "已连接" : "未连接"}
          hint={
            data.status.onebot.selfId !== null
              ? `Bot ${data.status.onebot.selfId}`
              : (data.status.onebot.lastError ?? "等待 NapCat")
          }
          icon={data.status.onebot.connected ? <Wifi /> : <WifiOff />}
        />
        <StatCard
          label="今日运行"
          value={formatNumber(usage.prompts)}
          hint={`${formatNumber(usage.tokens)} tokens · ${formatCurrency(usage.cost)}`}
          icon={<Clock3 />}
        />
        <StatCard
          label="待审批"
          value={formatNumber(data.counts.pendingApprovals)}
          hint={`${data.counts.activeRuns} 个活跃 run · ${data.counts.conversations} 个会话`}
          icon={<ShieldAlert />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>服务健康</CardTitle>
          <CardDescription>OpenCode service、事件流、数据库和队列。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
          <HealthRow
            label="OpenCode"
            ok={data.status.opencode.healthy}
            detail={
              data.status.opencode.healthy
                ? `${data.status.opencode.version ?? "unknown"} · ${data.status.opencode.url ?? "discovered"}`
                : (data.status.opencode.error ?? "不可用")
            }
          />
          <HealthRow
            label="事件流"
            ok={data.agentEvents.connected}
            detail={
              data.agentEvents.connected
                ? `最近事件 ${formatDate(data.agentEvents.lastEventAt)}`
                : (data.agentEvents.lastError ?? "未连接")
            }
          />
          <HealthRow
            label="SQLite"
            ok={data.status.db.ok}
            detail={data.status.db.ok ? "可读写" : "数据库异常"}
          />
          <HealthRow
            label="队列"
            ok={data.status.queue.active < 4}
            detail={`${data.status.queue.active} 活跃 · ${data.status.queue.depth} 排队`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>运行状态</CardTitle>
            <CardDescription>当前活跃和最近完成的 run。</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/sessions">
              会话 <ArrowRight />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有运行记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="hidden md:table-cell">Session</TableHead>
                  <TableHead className="text-right">开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <div className="font-mono text-xs">{shortId(run.id, 12)}</div>
                      <div className="text-xs text-muted-foreground">{run.chatKey}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{run.projectId}</Badge>
                    </TableCell>
                    <TableCell>
                      <RunBadge status={run.status} />
                    </TableCell>
                    <TableCell className="hidden max-w-40 md:table-cell">
                      <code className="block truncate text-[11px] text-muted-foreground">
                        {run.sessionId === null ? "—" : shortId(run.sessionId, 14)}
                      </code>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(run.startedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>待审批</CardTitle>
            <CardDescription>审批仍在 QQ 内完成；这里只做只读展示。</CardDescription>
          </CardHeader>
          <CardContent>
            {data.pendingApprovals.length === 0 ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4" /> 当前没有待审批请求。
              </div>
            ) : (
              <div className="space-y-2">
                {data.pendingApprovals.map((approval) => (
                  <div key={approval.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline">{approval.action}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(approval.requestedAt)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm">
                      {approval.resources.join(", ") || approval.message || "等待处理"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {approval.chatKey} · {approval.projectId}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>最近审计</CardTitle>
              <CardDescription>配置、运行、登录等管理事件。</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/audit">
                全部 <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {data.recentAudit.slice(0, 7).map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                >
                  <StatusDot
                    tone={
                      entry.action.includes("failed") || entry.action.includes("denied")
                        ? "error"
                        : "info"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{entry.action}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.actorQq ?? "system"} · {formatDate(entry.ts)}
                    </p>
                  </div>
                </div>
              ))}
              {data.recentAudit.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">暂无审计记录。</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {label}
          </p>
          <p className="truncate text-2xl font-semibold">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{hint}</p>
        </div>
        <div className="rounded-lg border bg-muted/40 p-2 text-muted-foreground [&>svg]:size-4">
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}

function HealthRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      <StatusDot tone={ok ? "ok" : "error"} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </p>
      </div>
    </div>
  );
}

function dedupeRuns<T extends { id: string }>(runs: T[]): T[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

export function RunBadge({ status }: { status: string }) {
  const variants: Record<string, { label: string; className: string }> = {
    queued: {
      label: "排队",
      className: "border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
    },
    running: { label: "运行中", className: "border-foreground/20 bg-foreground/5 text-foreground" },
    waiting_permission: {
      label: "等待审批",
      className: "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    completed: {
      label: "完成",
      className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    failed: {
      label: "失败",
      className: "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400",
    },
    cancelled: {
      label: "已取消",
      className: "border-zinc-500/20 bg-zinc-500/10 text-zinc-500",
    },
    interrupted: {
      label: "已中断",
      className: "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    rejected: {
      label: "被拒绝",
      className: "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400",
    },
  };
  const item = variants[status] ?? { label: status, className: "border-border bg-muted" };
  return (
    <Badge variant="outline" className={item.className}>
      {item.label}
    </Badge>
  );
}
