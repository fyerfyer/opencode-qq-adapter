import { Blocks, PackageOpen, PlugZap, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type {
  MetaInfo,
  PluginActionResult,
  PluginInfo,
  PluginOptionsSaveResult,
  PluginOptionsSnapshot,
} from "@/api/types";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApiQuery } from "@/hooks/use-api-query";
import { InstallPluginDialog } from "./components/install-plugin-dialog";
import { PluginCard } from "./components/plugin-card";
import { type ConfigDialogState, PluginOptionsDialog } from "./components/plugin-options-dialog";
import { UninstallDialog } from "./components/uninstall-dialog";

function actionWarnings(result: PluginActionResult): string[] {
  const warnings = new Set(result.warnings);
  for (const warning of result.reload.warnings) warnings.add(warning);
  if (!result.reload.ok && result.reload.error !== undefined) warnings.add(result.reload.error);
  return [...warnings].filter((warning) => warning !== result.plugin.error);
}

export function PluginsPage() {
  const { data, error, loading, refresh } = useApiQuery<MetaInfo>("/meta");
  const [busy, setBusy] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigDialogState | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<PluginInfo | null>(null);

  const updateConfig = (patch: Partial<ConfigDialogState>) => {
    setConfig((current) => (current === null ? null : { ...current, ...patch }));
  };

  const openConfig = async (plugin: PluginInfo) => {
    setConfigBusy(true);
    try {
      const snapshot = await api.get<PluginOptionsSnapshot>(
        `/plugins/${encodeURIComponent(plugin.id)}/options`,
      );
      setConfig({
        plugin,
        text: JSON.stringify(snapshot.options ?? {}, null, 2),
        hash: snapshot.configHash ?? "",
        error: null,
        snapshotError: snapshot.error,
      });
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setConfigBusy(false);
    }
  };

  const saveConfig = async () => {
    if (config === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.text);
    } catch {
      updateConfig({ error: "配置必须是合法 JSON。" });
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      updateConfig({ error: "插件 options 必须是 JSON 对象。" });
      return;
    }
    setConfigBusy(true);
    try {
      const result = await api.put<PluginOptionsSaveResult>(
        `/plugins/${encodeURIComponent(config.plugin.id)}/options`,
        {
          options: parsed as Record<string, unknown>,
          expectedHash: config.hash.length > 0 ? config.hash : undefined,
        },
      );
      toast.success(
        result.reload.warnings.length > 0
          ? `已保存；${result.reload.warnings.join("；")}`
          : "插件配置已保存并热加载",
      );
      setConfig(null);
      await refresh(true);
    } catch (caught) {
      updateConfig({ error: errorMessage(caught) });
    } finally {
      setConfigBusy(false);
    }
  };

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

  const runPluginAction = async (plugin: PluginInfo, action: "reload" | "rollback") => {
    const successText = action === "reload" ? "代码已重新加载" : "已回滚到上一版本";
    setBusy(plugin.id);
    try {
      const result = await api.post<PluginActionResult>(
        `/plugins/${encodeURIComponent(plugin.id)}/${action}`,
      );
      await refresh(true);
      const warnings = actionWarnings(result);
      const suffix = warnings.length > 0 ? `；${warnings.join("；")}` : "";
      if (result.plugin.status === "failed") {
        toast.error(
          `${plugin.name} ${successText}，但插件加载失败：${result.plugin.error ?? "未知错误"}${suffix}`,
        );
      } else if (!result.reload.ok || warnings.length > 0) {
        toast.warning(`${plugin.name} ${successText}${suffix}`);
      } else {
        toast.success(`${plugin.name} ${successText}`);
      }
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
          <>
            <Badge variant="outline">
              {pluginData.loaded}/{pluginData.total} 已加载
            </Badge>
            <Button size="sm" onClick={() => setInstallOpen(true)}>
              <Upload /> 安装插件
            </Button>
          </>
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
            <EmptyState
              title="还没有插件"
              description="上传一个自包含 ZIP，或注册本地插件目录。插件代码会以 bridge 进程权限运行，没有沙箱。"
              icon={<PlugZap className="size-5" />}
              action={
                <Button size="sm" onClick={() => setInstallOpen(true)}>
                  <Upload /> 安装插件
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              {pluginData.plugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  busy={busy === plugin.id}
                  configBusy={configBusy}
                  onToggle={(target, enabled) => void toggle(target, enabled)}
                  onConfigure={(target) => void openConfig(target)}
                  onReload={(target) => void runPluginAction(target, "reload")}
                  onRollback={(target) => void runPluginAction(target, "rollback")}
                  onUninstall={setUninstallTarget}
                />
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
          <CardDescription>插件信任与安装边界。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-2">
          {[
            ["可信代码，无沙箱", "插件代码以 bridge 进程权限运行，WebUI 不提供隔离。"],
            ["WebUI 上传仅管理员可用", "只有已登录管理员能上传 ZIP 或注册本地插件目录。"],
            [
              "不自动安装 npm 依赖、不执行构建/安装脚本",
              "插件包必须自带已构建入口；运行时依赖需要自行 bundle。",
            ],
            [
              "插件数据与代码目录分离",
              "托管代码位于 .managed/<id>，插件数据保留在 plugins_dir/<id>。",
            ],
          ].map(([title, description]) => (
            <div key={title} className="rounded-lg border p-3">
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <PluginOptionsDialog
        state={config}
        busy={configBusy}
        onChange={updateConfig}
        onClose={() => setConfig(null)}
        onSave={() => void saveConfig()}
      />

      <InstallPluginDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={async () => {
          await refresh(true);
        }}
      />

      <UninstallDialog
        plugin={uninstallTarget}
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
        onUninstalled={async () => {
          setUninstallTarget(null);
          await refresh(true);
        }}
      />
    </div>
  );
}
