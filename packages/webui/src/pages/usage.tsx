import { CalendarDays, Coins, Cpu, MessageSquare, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { DailyUsage } from "@/api/types";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatCurrency, formatNumber } from "@/lib/utils";

interface UsageResponse {
  day: string;
  rows: DailyUsage[];
  total: {
    prompts: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

export function UsagePage() {
  const [day, setDay] = useState(today());
  const { data, error, loading, refresh } = useApiQuery<UsageResponse>(`/usage?day=${day}`);

  if (loading && data === null) return <LoadingState rows={6} />;
  if (error !== null && data === null) {
    return (
      <ErrorState
        message={error}
        action={
          <Button size="sm" onClick={() => void refresh()}>
            <RefreshCw />
            重试
          </Button>
        }
      />
    );
  }
  if (data === null) return null;

  const maxCost = Math.max(0.0001, ...data.rows.map((row) => row.costUsd));

  return (
    <div className="space-y-6">
      <PageHeader
        title="用量"
        description="按天聚合的 prompt、token 和成本。数据来自 SQLite usage_daily。"
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="date"
                value={day}
                onChange={(event) => setDay(event.target.value)}
                className="w-44 pl-9"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw /> 刷新
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={<MessageSquare />}
          label="Prompts"
          value={formatNumber(data.total.prompts)}
        />
        <SummaryCard
          icon={<Cpu />}
          label="Input tokens"
          value={formatNumber(data.total.inputTokens)}
        />
        <SummaryCard
          icon={<Cpu />}
          label="Output tokens"
          value={formatNumber(data.total.outputTokens)}
        />
        <SummaryCard icon={<Coins />} label="Cost" value={formatCurrency(data.total.costUsd)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{data.day} 明细</CardTitle>
          <CardDescription>按用户和项目拆分；未记录的组合不会出现在列表里。</CardDescription>
        </CardHeader>
        <CardContent>
          {data.rows.length === 0 ? (
            <EmptyState
              title="当天没有用量"
              description="运行一次 prompt 后，这里会出现 token 与成本记录。"
              icon={<Coins />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead className="text-right">Prompts</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="hidden w-48 md:table-cell">占比</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={`${row.actorQq}-${row.projectId}`}>
                    <TableCell className="font-mono text-xs">
                      {row.actorQq === null ? "全部" : row.actorQq}
                    </TableCell>
                    <TableCell>
                      {row.projectId === null ? (
                        <span className="text-muted-foreground">全部</span>
                      ) : (
                        row.projectId
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(row.prompts)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.inputTokens)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.outputTokens)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(row.costUsd)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground"
                          style={{ width: `${Math.max(3, (row.costUsd / maxCost) * 100)}%` }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="rounded-lg border bg-muted/40 p-2.5 text-muted-foreground [&>svg]:size-4">
          {icon}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
