import { AlertTriangle, ArrowLeft, Download, LoaderCircle, ShieldAlert } from "lucide-react";
import type { PluginPackagePreview } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface InstallPreviewProps {
  preview: PluginPackagePreview;
  source: "upload" | "local";
  localPath?: string;
  enable: boolean;
  busy: boolean;
  onEnableChange: (enabled: boolean) => void;
  onBack: () => void;
  onClose: () => void;
  onInstall: () => void;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index] ?? "GiB"}`;
}

type VersionRelation = "same" | "upgrade" | "downgrade" | "unknown";

function compareVersions(current: string, next: string): VersionRelation {
  if (current === next) return "same";
  const left = current.replace(/^v/i, "").split(/[.+-]/);
  const right = next.replace(/^v/i, "").split(/[.+-]/);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? "0";
    const b = right[index] ?? "0";
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return "unknown";
    const difference = Number(a) - Number(b);
    if (difference !== 0) return difference > 0 ? "downgrade" : "upgrade";
  }
  return "same";
}

interface ExistingNotice {
  message: string;
  /** The server rejects this install, so the install action must stay disabled. */
  blocking: boolean;
}

function updateMessage(
  existing: NonNullable<PluginPackagePreview["existing"]>,
  nextVersion: string,
): string {
  const relation = compareVersions(existing.version, nextVersion);
  if (relation === "same") {
    return `该 ID 已安装 v${existing.version}（同版本），安装会覆盖现有代码并保留上一版本。`;
  }
  if (relation === "upgrade") {
    return `该 ID 已安装 v${existing.version}，将更新到 v${nextVersion} 并保留上一版本。`;
  }
  if (relation === "downgrade") {
    return `该 ID 已安装 v${existing.version}，新版本 v${nextVersion} 更低；将降级并保留上一版本。`;
  }
  return `该 ID 已安装 v${existing.version}，安装会覆盖现有代码并保留上一版本。`;
}

function localPathMessage(
  existing: NonNullable<PluginPackagePreview["existing"]>,
  nextVersion: string,
): string {
  const relation = compareVersions(existing.version, nextVersion);
  const base =
    relation === "same"
      ? `该 ID 已注册本地目录 v${existing.version}（同版本）。`
      : relation === "upgrade"
        ? `该 ID 已注册本地目录 v${existing.version}，将更新到 v${nextVersion}。`
        : relation === "downgrade"
          ? `该 ID 已注册本地目录 v${existing.version}，新版本 v${nextVersion} 更低。`
          : `该 ID 已注册本地目录 v${existing.version}。`;
  return `${base}仅当路径与当前配置一致时才会更新；不同路径会被拒绝。`;
}

function existingMessage(
  preview: PluginPackagePreview,
  source: "upload" | "local",
): ExistingNotice | null {
  const existing = preview.existing;
  if (existing === null) return null;

  if (source === "upload") {
    if (!existing.managed) {
      return {
        blocking: true,
        message: "该 ID 已被本地目录/npm 包占用，ZIP 安装会被拒绝。请先在 YAML/外部流程处理。",
      };
    }
    return { blocking: false, message: updateMessage(existing, preview.manifest.version) };
  }

  if (existing.managed) {
    return { blocking: true, message: "该 ID 由 WebUI 托管，本地目录注册会被拒绝。" };
  }
  if (existing.sourceKind === "package") {
    return { blocking: true, message: "该 ID 当前由 npm 包提供，本地目录注册会被拒绝。" };
  }
  return { blocking: false, message: localPathMessage(existing, preview.manifest.version) };
}

function Detail({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-xs text-foreground" title={title ?? value}>
        {value}
      </p>
    </div>
  );
}

export function InstallPreview({
  preview,
  source,
  localPath,
  enable,
  busy,
  onEnableChange,
  onBack,
  onClose,
  onInstall,
}: InstallPreviewProps) {
  const notice = existingMessage(preview, source);
  const blocking = notice?.blocking === true;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-medium">{preview.manifest.name}</p>
            <Badge variant="outline">v{preview.manifest.version}</Badge>
            <Badge variant="secondary">API {preview.manifest.apiVersion}</Badge>
            {preview.manifest.ui !== null ? <Badge variant="outline">iframe UI</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {preview.manifest.description ?? "插件未提供描述。"}
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onBack}>
          <ArrowLeft /> 重新选择
        </Button>
      </div>

      <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
        <Detail label="插件 ID" value={preview.manifest.id} />
        <Detail label="入口" value={preview.entry} />
        <Detail label="文件" value={`${preview.files.toLocaleString("zh-CN")} 个`} />
        <Detail label="解压大小" value={formatBytes(preview.bytes)} />
        {source === "local" && localPath !== undefined ? (
          <Detail label="本地目录" value={localPath} />
        ) : null}
        {preview.archive !== null ? (
          <Detail
            label="SHA-256"
            value={`${preview.archive.sha256.slice(0, 12)}…`}
            title={preview.archive.sha256}
          />
        ) : null}
        {preview.packageName !== null ? <Detail label="包名" value={preview.packageName} /> : null}
      </div>

      {(preview.manifest.capabilities.length > 0 ||
        preview.manifest.engines.opencodeQq !== null) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {preview.manifest.capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {capability}
            </Badge>
          ))}
          {preview.manifest.engines.opencodeQq !== null ? (
            <Badge variant="secondary">需要核心 {preview.manifest.engines.opencodeQq}</Badge>
          ) : null}
        </div>
      )}

      {notice !== null ? (
        <div
          className={cn(
            "rounded-lg border p-2 text-xs",
            blocking
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5" />
            {blocking ? "无法安装" : "将更新现有插件"}
          </p>
          <p className="mt-1 leading-5">{notice.message}</p>
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5" /> 安装前请确认
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="plugin-install-enable">安装后立即启用</Label>
          <p className="text-xs text-muted-foreground">
            关闭时只写入配置，插件保持禁用，稍后可在卡片中启用。
          </p>
        </div>
        <Switch
          id="plugin-install-enable"
          checked={enable}
          disabled={busy}
          onCheckedChange={onEnableChange}
        />
      </div>

      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
        <p className="flex items-center gap-1.5 font-medium">
          <ShieldAlert className="size-4" /> 插件代码会以 bridge 进程权限运行，没有沙箱。
        </p>
        <p className="mt-1">
          只安装你信任的代码。插件包必须自包含：WebUI 不执行 npm
          install、构建或安装脚本，运行时依赖需自行 bundle。
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy || blocking} onClick={onInstall}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
          {busy ? "正在安装…" : enable ? "安装并启用" : "仅安装"}
        </Button>
      </DialogFooter>
    </div>
  );
}
