import { Link2, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { RoleplayBinding } from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
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

export function BindingsTab() {
  const { data, error, loading, refresh } = useApiQuery<{ bindings: RoleplayBinding[] }>(
    "/plugins/roleplay/bindings",
    { intervalMs: 20_000 },
  );
  const [busy, setBusy] = useState<string | null>(null);

  const setEnabled = async (binding: RoleplayBinding, enabled: boolean) => {
    setBusy(binding.chatKey);
    try {
      await api.patch(`/plugins/roleplay/bindings?chatKey=${encodeURIComponent(binding.chatKey)}`, {
        enabled,
      });
      toast.success(enabled ? "已启用" : "已禁用");
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (binding: RoleplayBinding) => {
    try {
      await api.delete(`/plugins/roleplay/bindings?chatKey=${encodeURIComponent(binding.chatKey)}`);
      toast.success("绑定已删除；下一条 QQ 消息会按项目配置重新绑定");
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  if (loading && data === null) return <LoadingState rows={5} />;
  if (error !== null && data === null) return <ErrorState message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          QQ chatKey → persona 的绑定。删除绑定不会删除角色或记忆。
        </p>
        <Button variant="outline" size="sm" onClick={() => void refresh(true)}>
          <RefreshCw /> 刷新
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>当前绑定</CardTitle>
          <CardDescription>群聊 shared 模式下管理命令仅限 owner/admin。</CardDescription>
        </CardHeader>
        <CardContent>
          {(data?.bindings.length ?? 0) === 0 ? (
            <EmptyState
              title="还没有角色绑定"
              description="在 QQ 私聊或群聊发送 !persona use 角色ID，绑定会出现在这里。"
              icon={<Link2 />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chat</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>启停</TableHead>
                  <TableHead>原项目</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.bindings ?? []).map((binding) => (
                  <TableRow key={binding.chatKey}>
                    <TableCell className="font-mono text-xs">{binding.chatKey}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{binding.personaId}</Badge>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={binding.enabled}
                        disabled={busy === binding.chatKey}
                        onCheckedChange={(value) => void setEnabled(binding, value)}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {binding.previousProjectId ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(binding.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ConfirmDelete
                        title="删除绑定？"
                        description="不会删除角色或记忆；QQ 下一条消息会重新走项目选择。"
                        onConfirm={() => remove(binding)}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        }
                      />
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
