import { AlertTriangle, CheckCircle2, FileArchive, XCircle } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { type FileRejection, useDropzone } from "react-dropzone";
import { Link } from "react-router-dom";
import { api, errorMessage } from "@/api/client";
import type { PluginActionResult, PluginPackagePreview } from "@/api/types";
import { InlineLoading } from "@/components/common/data-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { InstallPreview } from "./install-preview";
import { LocalPathForm } from "./local-path-form";

type InstallSourceTab = "zip" | "local";

type InstallState =
  | { kind: "source" }
  | { kind: "inspecting" }
  | {
      kind: "preview";
      preview: PluginPackagePreview;
      source: "upload" | "local";
      localPath?: string;
    }
  | { kind: "installing" }
  | { kind: "result"; result: PluginActionResult | null; error: string | null };

interface PreviewSnapshot {
  preview: PluginPackagePreview;
  source: "upload" | "local";
  localPath?: string;
}

export interface InstallPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => Promise<void>;
}

function rejectionMessage(rejection: FileRejection | undefined): string | null {
  if (rejection === undefined) return null;
  const code = rejection.errors[0]?.code;
  if (code === "file-too-large") return "ZIP 不能超过 20 MiB。";
  if (code === "file-invalid-type") return "只接受 .zip 插件包。";
  if (code === "too-many-files") return "一次只能选择一个 ZIP 文件。";
  return "无法使用该文件，请重新选择。";
}

function resultWarnings(result: PluginActionResult): string[] {
  const warnings = new Set(result.warnings);
  for (const warning of result.reload.warnings) warnings.add(warning);
  if (!result.reload.ok && result.reload.error !== undefined) warnings.add(result.reload.error);
  return [...warnings];
}

/** Existing disabled plugins stay disabled; everything else keeps the current install flow. */
function defaultEnable(preview: PluginPackagePreview): boolean {
  const existing = preview.existing;
  if (existing === null) return true;
  return existing.status !== "disabled";
}

function InstallResultView({
  result,
  error,
  onClose,
  onRetry,
  onBack,
}: {
  result: PluginActionResult | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  if (result === null) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="flex items-center gap-2 font-medium">
            <XCircle className="size-4" /> 安装失败
          </p>
          <p className="mt-2 text-xs leading-5">{error ?? "未知错误"}</p>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          安装请求失败。请先查看插件卡片；如果插件已出现，以卡片状态为准，必要时卸载或回滚。
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onBack}>
            返回
          </Button>
          <Button onClick={onRetry}>重试</Button>
        </DialogFooter>
      </div>
    );
  }

  const failed = result.plugin.status === "failed";
  const degraded = failed || !result.reload.ok;
  const warnings = resultWarnings(result).filter((warning) => warning !== result.plugin.error);
  const page = result.plugin.admin.pages[0];
  const pageHref =
    page === undefined
      ? null
      : (page.path ??
        `/plugins/${encodeURIComponent(result.plugin.id)}/${encodeURIComponent(page.id)}`);
  const sourceLabel =
    result.install?.managed === true
      ? "WebUI 托管"
      : result.install?.sourceKind === "package"
        ? "npm 包"
        : "本地目录";

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "rounded-lg border p-3",
          failed
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : degraded
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        <p className="flex items-center gap-2 text-sm font-medium">
          {failed ? (
            <XCircle className="size-4" />
          ) : degraded ? (
            <AlertTriangle className="size-4" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          {failed
            ? "已安装，但插件加载失败"
            : !result.reload.ok
              ? "已安装，但配置热加载失败"
              : result.plugin.status === "disabled"
                ? "安装完成，插件当前未启用"
                : "安装完成，插件已加载"}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span>
            {result.plugin.name} · v{result.plugin.version}
          </span>
          <Badge variant="outline">{sourceLabel}</Badge>
        </p>
      </div>

      <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2">
        <p>
          <span className="text-muted-foreground">插件 ID：</span>
          <span className="font-mono">{result.plugin.id}</span>
        </p>
        <p>
          <span className="text-muted-foreground">状态：</span>
          {result.plugin.status}
        </p>
        {result.install?.previousVersion !== null &&
        result.install?.previousVersion !== undefined ? (
          <p>
            <span className="text-muted-foreground">上一版本：</span>v
            {result.install.previousVersion}
          </p>
        ) : null}
        {result.install?.managed === true && result.install.backups > 0 ? (
          <p>
            <span className="text-muted-foreground">备份：</span>
            {result.install.backups} 个
          </p>
        ) : null}
      </div>

      {failed && result.plugin.error !== null ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs leading-5 text-destructive">
          {result.plugin.error}
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5" /> 警告
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {failed ? (
        <p className="text-xs leading-5 text-muted-foreground">
          插件文件和配置已保留。可以到插件卡片修改 options，托管插件还可以回滚到上一版本或卸载。
        </p>
      ) : null}

      <DialogFooter>
        {pageHref !== null ? (
          <Button variant="outline" asChild>
            <Link to={pageHref} onClick={onClose}>
              查看插件页
            </Link>
          </Button>
        ) : null}
        <Button onClick={onClose}>完成</Button>
      </DialogFooter>
    </div>
  );
}

export function InstallPluginDialog({ open, onOpenChange, onInstalled }: InstallPluginDialogProps) {
  const [tab, setTab] = useState<InstallSourceTab>("zip");
  const [state, setState] = useState<InstallState>({ kind: "source" });
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [enable, setEnable] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const reset = () => {
    setTab("zip");
    setState({ kind: "source" });
    setSnapshot(null);
    setFile(null);
    setLocalPath("");
    setEnable(true);
    setSourceError(null);
  };

  useLayoutEffect(() => {
    if (!open) return;
    setTab("zip");
    setState({ kind: "source" });
    setSnapshot(null);
    setFile(null);
    setLocalPath("");
    setEnable(true);
    setSourceError(null);
  }, [open]);

  const close = () => {
    onOpenChange(false);
  };

  const inspectUpload = async (selected: File) => {
    setSourceError(null);
    setState({ kind: "inspecting" });
    try {
      const form = new FormData();
      form.append("file", selected);
      const preview = await api.upload<PluginPackagePreview>("/plugins/install/preview", form);
      const next: PreviewSnapshot = { preview, source: "upload" };
      setEnable(defaultEnable(preview));
      setSnapshot(next);
      setState({ kind: "preview", ...next });
    } catch (caught) {
      setState({ kind: "source" });
      setSourceError(errorMessage(caught));
    }
  };

  const inspectLocal = async (pathOverride?: string) => {
    const target = (pathOverride ?? localPath).trim();
    if (target.length === 0) {
      setSourceError("请输入本地插件目录路径。");
      return;
    }
    setSourceError(null);
    setState({ kind: "inspecting" });
    try {
      const preview = await api.post<PluginPackagePreview>("/plugins/local/preview", {
        path: target,
      });
      const next: PreviewSnapshot = { preview, source: "local", localPath: target };
      setEnable(defaultEnable(preview));
      setSnapshot(next);
      setState({ kind: "preview", ...next });
    } catch (caught) {
      setState({ kind: "source" });
      setSourceError(errorMessage(caught));
    }
  };

  const dropzone = useDropzone({
    accept: { "application/zip": [".zip"] },
    maxFiles: 1,
    maxSize: 20 * 1024 * 1024,
    multiple: false,
    disabled: state.kind === "inspecting" || state.kind === "installing",
    onDrop: (accepted) => {
      const selected = accepted[0];
      if (selected === undefined) return;
      setFile(selected);
      void inspectUpload(selected);
    },
  });
  const sourceLocked = state.kind === "inspecting" || state.kind === "installing";

  const install = async () => {
    if (state.kind !== "preview") return;
    const current = state;
    setState({ kind: "installing" });
    try {
      const result =
        current.preview.uploadId !== null
          ? await api.post<PluginActionResult>("/plugins/install", {
              uploadId: current.preview.uploadId,
              enable,
              expectedHash: current.preview.configHash ?? undefined,
            })
          : await api.post<PluginActionResult>("/plugins/local/install", {
              path: current.localPath ?? localPath.trim(),
              enable,
              expectedHash: current.preview.configHash ?? undefined,
            });
      try {
        await onInstalled();
      } catch {
        // The mutation already succeeded; the next page load will refresh the catalog.
      }
      setState({ kind: "result", result, error: null });
    } catch (caught) {
      setState({ kind: "result", result: null, error: errorMessage(caught) });
    }
  };

  const backToSource = () => {
    if (state.kind !== "preview") return;
    setTab(state.source === "local" ? "local" : "zip");
    setSnapshot(null);
    setFile(null);
    setSourceError(null);
    setState({ kind: "source" });
  };

  const retry = () => {
    const last = snapshot;
    if (last?.source === "local" && last.localPath !== undefined) {
      setLocalPath(last.localPath);
      void inspectLocal(last.localPath);
      return;
    }
    if (last?.source === "upload" && file !== null) {
      void inspectUpload(file);
      return;
    }
    reset();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && (state.kind === "inspecting" || state.kind === "installing")) return;
    onOpenChange(next);
  };

  const rejection = rejectionMessage(dropzone.fileRejections[0]);
  const sourceView = state.kind === "source" || state.kind === "inspecting";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>安装插件</DialogTitle>
          <DialogDescription>
            上传一个自包含 ZIP，或注册本地插件目录。插件代码会以 bridge 进程权限运行，没有沙箱。
          </DialogDescription>
        </DialogHeader>

        {sourceView ? (
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (state.kind === "inspecting") return;
              setTab(value === "local" ? "local" : "zip");
              setSourceError(null);
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="zip" disabled={state.kind === "inspecting"}>
                上传 ZIP
              </TabsTrigger>
              <TabsTrigger value="local" disabled={state.kind === "inspecting"}>
                本地目录
              </TabsTrigger>
            </TabsList>

            <TabsContent value="zip" className="mt-3 space-y-3">
              <div
                {...dropzone.getRootProps()}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-6 text-center transition-colors outline-none",
                  "hover:border-primary/60 hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  dropzone.isDragActive && "border-primary bg-primary/5",
                  sourceLocked && "pointer-events-none opacity-60",
                )}
              >
                <input {...dropzone.getInputProps()} />
                <div className="flex size-11 items-center justify-center rounded-xl border bg-background text-muted-foreground">
                  <FileArchive className="size-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {dropzone.isDragActive ? "松开以检查插件包" : "拖入 .zip，或点击选择文件"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    最大 20 MiB；根目录需包含 package.json 和已构建入口。
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={sourceLocked}>
                  选择 ZIP 文件
                </Button>
              </div>
              {file !== null ? (
                <p className="truncate text-xs text-muted-foreground">
                  已选择：<span className="font-mono">{file.name}</span>
                </p>
              ) : null}
              {state.kind === "inspecting" && tab === "zip" ? (
                <InlineLoading label={`正在检查 ${file?.name ?? "插件包"}…`} />
              ) : null}
              {rejection !== null ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  {rejection}
                </p>
              ) : sourceError !== null ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  {sourceError}
                </p>
              ) : null}
            </TabsContent>

            <TabsContent value="local" className="mt-3 space-y-3">
              <LocalPathForm
                value={localPath}
                busy={state.kind === "inspecting"}
                error={sourceError}
                onChange={(value) => {
                  setLocalPath(value);
                  setSourceError(null);
                }}
                onInspect={() => void inspectLocal()}
              />
              {state.kind === "inspecting" && tab === "local" ? (
                <InlineLoading label="正在检查本地插件目录…" />
              ) : null}
            </TabsContent>
          </Tabs>
        ) : null}

        {state.kind === "preview" ? (
          <InstallPreview
            preview={state.preview}
            source={state.source}
            localPath={state.localPath}
            enable={enable}
            busy={false}
            onEnableChange={setEnable}
            onBack={backToSource}
            onClose={close}
            onInstall={() => void install()}
          />
        ) : null}

        {state.kind === "installing" && snapshot !== null ? (
          <InstallPreview
            preview={snapshot.preview}
            source={snapshot.source}
            localPath={snapshot.localPath}
            enable={enable}
            busy
            onEnableChange={() => undefined}
            onBack={() => undefined}
            onClose={() => undefined}
            onInstall={() => undefined}
          />
        ) : null}

        {state.kind === "result" ? (
          <InstallResultView
            result={state.result}
            error={state.error}
            onClose={close}
            onRetry={retry}
            onBack={reset}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
