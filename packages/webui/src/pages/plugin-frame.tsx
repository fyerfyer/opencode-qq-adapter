import type { PluginUiConfirmParams, PluginUiTheme } from "@opencode-qq/plugin-sdk/ui-protocol";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import type { PluginUiPageDescriptor } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { PluginBridgeHost } from "@/lib/plugin-bridge";

const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
];

type FrameState = "connecting" | "ready" | "timeout";
type ConfirmState = PluginUiConfirmParams & { resolve: (confirmed: boolean) => void };

export function PluginFramePage() {
  const { pluginId = "", pageId } = useParams();
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [nonce, setNonce] = useState("");
  const [frameState, setFrameState] = useState<FrameState>("connecting");
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<PluginBridgeHost | null>(null);

  const path = useMemo(() => {
    const base = `/plugins/${encodeURIComponent(pluginId)}/ui`;
    return pageId === undefined ? base : `${base}/${encodeURIComponent(pageId)}`;
  }, [pluginId, pageId]);
  const descriptor = useApiQuery<PluginUiPageDescriptor>(pluginId.length > 0 ? path : null);

  useEffect(() => {
    if (descriptor.data === null) return;
    setNonce(crypto.randomUUID());
    setFrameState("connecting");
  }, [descriptor.data]);

  const theme = useCallback((): PluginUiTheme => {
    const styles = window.getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const name of THEME_TOKENS) {
      const value = styles.getPropertyValue(name).trim();
      if (value.length > 0) tokens[name] = value;
    }
    return { mode: resolvedTheme === "dark" ? "dark" : "light", tokens };
  }, [resolvedTheme]);

  const themeRef = useRef<PluginUiTheme>(theme());
  themeRef.current = theme();

  const confirm = useCallback(
    (params: PluginUiConfirmParams) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ ...params, resolve });
      }),
    [],
  );

  const finishConfirm = useCallback((confirmed: boolean) => {
    setConfirmState((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (descriptor.data === null || nonce.length === 0 || iframe === null) return;
    setFrameState("connecting");
    const host = new PluginBridgeHost({
      iframe,
      descriptor: descriptor.data,
      nonce,
      getTheme: () => themeRef.current,
      toast: (message, type) => {
        if (type === "success") toast.success(message);
        else if (type === "error") toast.error(message);
        else if (type === "warning") toast.warning(message);
        else toast.info(message);
      },
      confirm,
      navigate: (target) => navigate(target),
      onReady: () => setFrameState("ready"),
      onTimeout: () => setFrameState("timeout"),
    });
    hostRef.current = host;
    host.start();
    return () => {
      host.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [descriptor.data, nonce, confirm, navigate]);

  useEffect(() => {
    // next-themes updates the root class in an effect; wait one frame so the
    // computed CSS variables belong to the new mode.
    const frame = window.requestAnimationFrame(() => {
      hostRef.current?.updateTheme(theme());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [theme]);

  if (pluginId.length === 0) {
    return <ErrorState message="插件页面地址不完整。" />;
  }
  if (descriptor.loading && descriptor.data === null) return <LoadingState rows={6} />;
  if (descriptor.error !== null && descriptor.data === null) {
    return (
      <ErrorState
        message={descriptor.error}
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void descriptor.refresh()}>
              重试
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/plugins">返回插件页</Link>
            </Button>
          </div>
        }
      />
    );
  }
  if (descriptor.data === null) return null;

  const reload = () => {
    setNonce(crypto.randomUUID());
    setFrameState("connecting");
  };

  return (
    <div className="relative -m-4 flex min-h-0 flex-1 md:-m-6 lg:-m-8">
      {frameState !== "ready" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center backdrop-blur-sm">
          {frameState === "connecting" ? (
            <>
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">正在连接插件 bridge…</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">插件页面没有响应 bridge</p>
              <p className="max-w-md text-sm text-muted-foreground">
                页面可能加载失败、包含脚本错误，或者没有使用 @opencode-qq/plugin-ui。
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={reload}>
                  <RefreshCw /> 重新加载
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <Link to="/plugins">返回插件页</Link>
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      <iframe
        key={nonce}
        ref={iframeRef}
        src={
          nonce.length === 0
            ? descriptor.data.url
            : `${descriptor.data.url}${descriptor.data.url.includes("?") ? "&" : "?"}__qq_ui=${encodeURIComponent(nonce)}`
        }
        title={`${descriptor.data.title} · 插件页面`}
        sandbox="allow-scripts allow-forms allow-downloads"
        referrerPolicy="no-referrer"
        allow="clipboard-write"
        className="h-full min-h-[32rem] w-full border-0 bg-background"
      />

      <AlertDialog
        open={confirmState !== null}
        onOpenChange={(open) => {
          if (!open) finishConfirm(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title ?? "确认操作"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmState?.description ?? "此操作由插件页面发起。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finishConfirm(false)}>
              {confirmState?.cancelText ?? "取消"}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={confirmState?.destructive === true ? "destructive" : "default"}
              onClick={() => finishConfirm(true)}
            >
              {confirmState?.confirmText ?? "确定"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
