import { RefreshCw, ScrollText, Search } from "lucide-react";
import { useState } from "react";
import type { AuditRecord } from "@/api/types";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "@/lib/utils";

export function AuditPage() {
  const [limit, setLimit] = useState("200");
  const { data, error, loading, refresh } = useApiQuery<{ entries: AuditRecord[] }>(
    `/audit?limit=${limit}`,
    { intervalMs: 30_000 },
  );
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<AuditRecord | null>(null);

  if (loading && data === null) return <LoadingState rows={7} />;
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

  const keyword = filter.trim().toLowerCase();
  const entries = data.entries.filter((entry) => {
    if (keyword === "") return true;
    return (
      entry.action.toLowerCase().includes(keyword) ||
      (entry.actorQq?.toString() ?? "").includes(keyword) ||
      (entry.projectId ?? "").toLowerCase().includes(keyword) ||
      (entry.chatKey ?? "").toLowerCase().includes(keyword) ||
      JSON.stringify(entry.detail).toLowerCase().includes(keyword)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="审计"
        description="登录、审批、运行、配置修改、权限拒绝等事件。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw /> 刷新
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="过滤 action / QQ / 项目 / detail"
            className="pl-9"
          />
        </div>
        <Select value={limit} onValueChange={setLimit}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="50">最近 50</SelectItem>
            <SelectItem value="100">最近 100</SelectItem>
            <SelectItem value="200">最近 200</SelectItem>
            <SelectItem value="500">最近 500</SelectItem>
          </SelectContent>
        </Select>
        <Badge variant="secondary">{entries.length} 条</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>事件列表</CardTitle>
          <CardDescription>点击一行查看结构化 detail。</CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <EmptyState
              title="没有匹配的审计事件"
              description="尝试清空过滤条件，或等待新的运行事件。"
              icon={<ScrollText />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">时间</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>主体</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead className="hidden lg:table-cell">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow
                    key={entry.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(entry)}
                  >
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(entry.ts)}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{entry.action}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.actorQq ?? "system"}
                      {entry.chatKey !== null && <div className="text-[11px]">{entry.chatKey}</div>}
                    </TableCell>
                    <TableCell>
                      {entry.projectId === null ? (
                        "—"
                      ) : (
                        <Badge variant="outline">{entry.projectId}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden max-w-md lg:table-cell">
                      <code className="block truncate text-[11px] text-muted-foreground">
                        {JSON.stringify(entry.detail)}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selected !== null && (
        <Dialog open onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{selected.action}</DialogTitle>
              <DialogDescription>
                {formatDate(selected.ts)} · {selected.chatKey ?? "no chat"} ·{" "}
                {selected.projectId ?? "no project"}
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5">
              {JSON.stringify(selected.detail, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
