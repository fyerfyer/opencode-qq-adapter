import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { PluginInfo, PluginOptionsSnapshot, PluginUninstallResult } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export interface UninstallDialogProps {
  plugin: PluginInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUninstalled: () => Promise<void>;
}

function uninstallIssues(
  result: PluginUninstallResult,
  plugin: PluginInfo,
  deleteData: boolean,
): string[] {
  const issues = new Set(result.warnings);
  if (!result.configRemoved) issues.add("YAML 配置未能移除。");
  if (!result.reload.ok) {
    issues.add(result.reload.error ?? "配置已移除，但热加载失败；请检查服务日志或重启后确认。");
  }
  if (plugin.managed && !result.codeRemoved) {
    issues.add(`托管代码目录未删除，请手动检查 .managed/${plugin.id}。`);
  }
  if (deleteData && !result.dataDeleted) {
    issues.add(`插件数据目录未删除，请手动检查 plugins_dir/${plugin.id}。`);
  }
  return [...issues];
}

export function UninstallDialog({
  plugin,
  open,
  onOpenChange,
  onUninstalled,
}: UninstallDialogProps) {
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PluginUninstallResult | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [expectedHash, setExpectedHash] = useState<string | null>(null);
  const [hashReady, setHashReady] = useState(false);
  const [hashError, setHashError] = useState<string | null>(null);
  const pluginId = plugin?.id ?? null;

  useLayoutEffect(() => {
    if (!open) return;
    setDeleteData(false);
    setBusy(false);
    setError(null);
    setResult(null);
    setIssues([]);
    setExpectedHash(null);
    setHashReady(false);
    setHashError(null);
  }, [open]);

  useEffect(() => {
    if (!open || pluginId === null) return;
    let cancelled = false;
    setExpectedHash(null);
    setHashReady(false);
    setHashError(null);
    void api
      .get<PluginOptionsSnapshot>(`/plugins/${encodeURIComponent(pluginId)}/options`)
      .then((snapshot) => {
        if (cancelled) return;
        setExpectedHash(snapshot.configHash);
        setHashReady(true);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setExpectedHash(null);
        setHashError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [open, pluginId]);

  const uninstall = async () => {
    if (plugin === null || !hashReady) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<PluginUninstallResult>(
        `/plugins/${encodeURIComponent(plugin.id)}/uninstall`,
        { deleteData, expectedHash: expectedHash ?? undefined },
      );
      const found = uninstallIssues(response, plugin, deleteData);
      if (found.length === 0) {
        toast.success(`${plugin.name} 已卸载`);
        await onUninstalled();
        return;
      }
      setResult(response);
      setIssues(found);
      toast.warning(`${plugin.name} 的配置已移除，但存在需要检查的警告`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && busy) return;
    if (!next && result !== null) {
      void onUninstalled();
      return;
    }
    onOpenChange(next);
  };

  const codeDescription =
    plugin?.managed === true
      ? `WebUI 托管插件：卸载会从 YAML 移除 plugins.${plugin.id}，并删除 .managed/${plugin.id} 代码目录。`
      : plugin?.sourceKind === "package"
        ? `npm 包插件：卸载只会从 YAML 移除 plugins.${plugin?.id ?? ""}，不会删除已安装的 npm 包。`
        : `本地目录插件：卸载只会从 YAML 移除 plugins.${plugin?.id ?? ""}，不会删除磁盘上的代码目录。`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>卸载插件 · {plugin?.name}</DialogTitle>
          <DialogDescription>{codeDescription}</DialogDescription>
        </DialogHeader>

        {result === null ? (
          <>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
              此操作会修改 YAML 配置，正在运行的核心功能可能立即变化。
            </div>

            <div className="flex items-start gap-3 rounded-lg border p-3">
              <Checkbox
                id="plugin-delete-data"
                checked={deleteData}
                disabled={busy}
                onCheckedChange={(checked) => setDeleteData(checked === true)}
              />
              <div className="space-y-1">
                <Label htmlFor="plugin-delete-data">同时删除插件数据</Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  删除 <span className="font-mono">plugins_dir/{plugin?.id}</span>
                  。聊天绑定、缓存等插件数据将不可恢复；默认保留。
                </p>
              </div>
            </div>

            {error !== null ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}

            {!hashReady && hashError === null ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <LoaderCircle className="size-3.5 animate-spin" /> 正在读取配置版本…
              </p>
            ) : hashError !== null ? (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
                role="alert"
                title={hashError}
              >
                无法读取配置版本，请关闭后重试
              </p>
            ) : null}

            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={busy || !hashReady}
                onClick={() => void uninstall()}
              >
                {busy ? "正在卸载…" : "卸载"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4" /> YAML 配置已移除
              </p>
              <p className="mt-1 text-xs">
                插件 {plugin?.name} 已从配置中卸载；以下项目需要手动检查。
              </p>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" /> 卸载警告
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
            <DialogFooter>
              <Button onClick={() => void onUninstalled()}>完成</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
