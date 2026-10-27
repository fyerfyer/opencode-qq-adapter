import {
  ExternalLink,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { PluginInfo } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";

export interface PluginCardProps {
  plugin: PluginInfo;
  busy: boolean;
  configBusy: boolean;
  onToggle: (plugin: PluginInfo, enabled: boolean) => void;
  onConfigure: (plugin: PluginInfo) => void;
  onReload: (plugin: PluginInfo) => void;
  onRollback: (plugin: PluginInfo) => void;
  onUninstall: (plugin: PluginInfo) => void;
}

function statusBadge(plugin: PluginInfo) {
  if (plugin.status === "loaded") return <Badge>已加载</Badge>;
  if (plugin.status === "failed") return <Badge variant="destructive">失败</Badge>;
  if (plugin.status === "disabled") return <Badge variant="outline">已禁用</Badge>;
  return <Badge variant="secondary">已停止</Badge>;
}

export function PluginCard({
  plugin,
  busy,
  configBusy,
  onToggle,
  onConfigure,
  onReload,
  onRollback,
  onUninstall,
}: PluginCardProps) {
  return (
    <div className="rounded-xl border bg-background/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{plugin.name}</p>
          <Badge variant="outline">v{plugin.version}</Badge>
          {statusBadge(plugin)}
          {plugin.managed ? <Badge variant="outline">WebUI 托管</Badge> : null}
          {plugin.sourceKind === "package" ? <Badge variant="outline">npm 包</Badge> : null}
          {!plugin.managed && plugin.sourceKind === "path" ? (
            <Badge variant="outline">本地目录</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {busy ? (
            <LoaderCircle
              className="size-4 animate-spin text-muted-foreground"
              aria-label="操作进行中"
            />
          ) : null}
          <span className="text-xs text-muted-foreground">API {plugin.apiVersion || "-"}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={configBusy || busy}
            onClick={() => onConfigure(plugin)}
          >
            <Settings2 /> 配置
          </Button>
          <Switch
            checked={plugin.status !== "disabled"}
            disabled={busy}
            onCheckedChange={(value) => onToggle(plugin, value)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={`${plugin.name} 更多操作`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={busy} onSelect={() => onReload(plugin)}>
                <RefreshCw /> 重新加载代码
              </DropdownMenuItem>
              {plugin.managed ? (
                <DropdownMenuItem disabled={busy} onSelect={() => onRollback(plugin)}>
                  <RotateCcw /> 回滚到上一版本
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onSelect={() => onUninstall(plugin)}
              >
                <Trash2 /> 卸载
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{plugin.description ?? plugin.id}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {plugin.commands.map((command) => (
          <Badge key={command} variant="secondary">
            !{command}
          </Badge>
        ))}
        {plugin.capabilities.map((capability) => (
          <Badge key={capability} variant="outline">
            {capability}
          </Badge>
        ))}
        {plugin.admin.routes > 0 && (
          <Badge variant="outline">{plugin.admin.routes} admin routes</Badge>
        )}
      </div>
      {plugin.admin.pages.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {plugin.admin.pages.map((page) => {
            const to =
              page.path ??
              `/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(page.id)}`;
            return (
              <Button key={page.id} variant="outline" size="sm" asChild>
                <Link to={to}>
                  <ExternalLink /> {page.title}
                  <span className="text-[10px] text-muted-foreground">
                    {page.kind === "iframe" ? "iframe" : "native"}
                  </span>
                </Link>
              </Button>
            );
          })}
        </div>
      )}
      {plugin.error !== null ? (
        <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {plugin.error}
        </p>
      ) : null}
      <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground">{plugin.source}</p>
    </div>
  );
}
