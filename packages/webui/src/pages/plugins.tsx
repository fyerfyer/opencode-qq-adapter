import { Blocks, PackageOpen, PlugZap } from "lucide-react";
import type { MetaInfo } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApiQuery } from "@/hooks/use-api-query";

export function PluginsPage() {
  const { data, error, loading, refresh } = useApiQuery<MetaInfo>("/meta");

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="插件"
        description="插件使用独立 manifest、数据目录和页面，不共享核心 React 运行时。"
        actions={<Badge variant="outline">Plugin SDK · 规划中</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Blocks className="size-4" /> 已安装插件
          </CardTitle>
          <CardDescription>当前版本只提供核心管理壳，插件加载器尚未启用。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-muted/20 p-8 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl border bg-muted text-foreground">
              <PlugZap className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">还没有插件</p>
              <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                {data.plugins.message}
              </p>
            </div>
            <div className="grid w-full max-w-2xl gap-3 pt-2 text-left sm:grid-cols-3">
              {[
                ["核心", "QQ / 会话 / 权限 / 审计"],
                ["SDK", "manifest / hooks / dataDir"],
                ["页面", "/admin/plugins/:id"],
              ].map(([title, description]) => (
                <div key={title} className="rounded-lg border bg-background/60 p-3">
                  <p className="text-xs font-semibold">{title}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{description}</p>
                </div>
              ))}
            </div>
          </div>
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
            ["不动态加载代码", "只从 YAML / CLI 显式启用插件。"],
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
