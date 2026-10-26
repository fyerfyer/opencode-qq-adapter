import { Blocks, ExternalLink, PackageOpen, PlugZap, Settings2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { MetaInfo, PluginInfo } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useApiQuery } from "@/hooks/use-api-query";

function statusBadge(plugin: PluginInfo) {
  if (plugin.status === "loaded") return <Badge>已加载</Badge>;
  if (plugin.status === "failed") return <Badge variant="destructive">失败</Badge>;
  if (plugin.status === "disabled") return <Badge variant="outline">已禁用</Badge>;
  return <Badge variant="secondary">已停止</Badge>;
}

export function PluginsPage() {
  const { data, error, loading, refresh } = useApiQuery<MetaInfo>("/meta");
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (plugin: PluginInfo, enabled: boolean) => {
    setBusy(plugin.id);
    try {
      await api.put(`/plugins/${encodeURIComponent(plugin.id)}/enabled`, { enabled });
      toast.success(enabled ? `${plugin.name} 已启用` : `${plugin.name} 已禁用`);
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  if (loading && data === null) return <LoadingState rows={4} />;
  if (error !== null && data === null)
    return (
      <ErrorState
        message={error}
        action={
          <Button size="sm" onClick={() => void refresh()}>
            重试
          </Button>
        }
      />
    );
  if (data === null) return null;

  const pluginData = data.plugins;

  return (
    <div className="space-y-6">
      <PageHeader
        title="插件"
        description="插件使用独立 manifest、数据目录和命令；失败插件不会影响核心。"
        actions={
          <Badge variant="outline">
            {pluginData.loaded}/{pluginData.total} 已加载
          </Badge>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Blocks className="size-4" /> 已安装插件
          </CardTitle>
          <CardDescription>{pluginData.message}</CardDescription>
        </CardHeader>
        <CardContent>
          {pluginData.plugins.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-muted/20 p-8 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl border bg-muted text-foreground">
                <PlugZap className="size-6" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">还没有插件</p>
                <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                  在 YAML 的 plugins 段显式启用插件。插件只从配置文件加载，不从 QQ 或 WebUI
                  上传代码。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {pluginData.plugins.map((plugin) => (
                <div key={plugin.id} className="rounded-xl border bg-background/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{plugin.name}</p>
                      <Badge variant="outline">v{plugin.version}</Badge>
                      {statusBadge(plugin)}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        API {plugin.apiVersion || "-"}
                      </span>
                      <Switch
                        checked={plugin.status !== "disabled"}
                        disabled={busy === plugin.id}
                        onCheckedChange={(value) => void toggle(plugin, value)}
                      />
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {plugin.description ?? plugin.id}
                  </p>
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
                    <div className="mt-3 flex flex-wrap gap-2">
                      {plugin.admin.pages.map((page) => (
                        <Button key={page.id} variant="outline" size="sm" asChild>
                          <Link to={page.path}>
                            <ExternalLink /> {page.title}
                          </Link>
                        </Button>
                      ))}
                      {plugin.id === "roleplay" && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link to="/roleplay?tab=settings">
                            <Settings2 /> 配置
                          </Link>
                        </Button>
                      )}
                    </div>
                  )}
                  {plugin.error !== null ? (
                    <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                      {plugin.error}
                    </p>
                  ) : null}
                  <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground">
                    {plugin.source}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageOpen className="size-4" /> 插件边界
          </CardTitle>
          <CardDescription>来自 docs/design/webui-and-plugin-sdk.md 的约束。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-2">
          {[
            ["不替换权限引擎", "插件不能绕过核心权限和审批。"],
            ["不动态加载代码", "只从 YAML 显式启用插件。"],
            ["不直接访问核心表", "插件使用独立目录和 SQLite。"],
            ["不共享 React 运行时", "插件页面由核心挂载并继承鉴权。"],
          ].map(([title, description]) => (
            <div key={title} className="rounded-lg border p-3">
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
