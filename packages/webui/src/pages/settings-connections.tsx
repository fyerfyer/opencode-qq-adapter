import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  PlugZap,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { ConnectionSaveResult, ConnectionsSnapshot } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { StatusDot } from "@/components/common/status-dot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn, formatDate } from "@/lib/utils";

const PLUGIN_STATUS_LABELS: Record<"disabled" | "loaded" | "failed" | "stopped", string> = {
  loaded: "已加载",
  disabled: "已禁用",
  failed: "加载失败",
  stopped: "已停止",
};

export function ConnectionsSettings() {
  const connections = useApiQuery<ConnectionsSnapshot>("/connections", { intervalMs: 15_000 });
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [napcatBusy, setNapcatBusy] = useState(false);
  const [jevBusy, setJevBusy] = useState(false);
  const [napcatResult, setNapcatResult] = useState<ConnectionSaveResult | null>(null);
  const [jevResult, setJevResult] = useState<ConnectionSaveResult | null>(null);
  const urlInitialized = useRef(false);

  useEffect(() => {
    if (connections.data !== null && !urlInitialized.current) {
      setUrl(connections.data.napcat.url);
      urlInitialized.current = true;
    }
  }, [connections.data]);

  const napcat = connections.data?.napcat;
  const jev = connections.data?.jev ?? null;
  const status = napcat?.status;
  const tone =
    status === undefined || !status.connected
      ? "error"
      : status.loginOk === false
        ? "warn"
        : status.loginOk === true
          ? "ok"
          : "info";
  const statusLabel =
    status === undefined || !status.connected
      ? "NapCat 未连接"
      : status.loginOk === false
        ? "QQ 登录态失效"
        : status.loginOk === true
          ? "已连接"
          : "连接中，等待登录探测";

  const saveNapcat = async () => {
    if (connections.data === null) return;
    setNapcatBusy(true);
    setNapcatResult(null);
    try {
      const result = await api.put<ConnectionSaveResult>("/connections/napcat", {
        url,
        ...(token.trim().length > 0 ? { accessToken: token.trim() } : {}),
        expectedEnvHash: connections.data.envHash,
      });
      setNapcatResult(result);
      setToken("");
      await connections.refresh(true);
      toast.success("NapCat 连接配置已保存；需要重启 bridge 后生效");
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setNapcatBusy(false);
    }
  };

  const saveJev = async () => {
    if (connections.data === null || jev === null) return;
    setJevBusy(true);
    setJevResult(null);
    try {
      const result = await api.put<ConnectionSaveResult>("/connections/jev", {
        apiKey: apiKey.trim(),
        expectedEnvHash: connections.data.envHash,
      });
      setJevResult(result);
      setApiKey("");
      await connections.refresh(true);
      if (result.reload?.ok === false) {
        toast.warning(`Jev 密钥已保存，但 Roleplay 重载失败：${result.reload.error ?? "未知错误"}`);
      } else {
        toast.success("Jev 密钥已保存并重新加载 Roleplay");
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setJevBusy(false);
    }
  };

  if (connections.loading && connections.data === null) return <LoadingState rows={4} />;
  if (connections.error !== null && connections.data === null) {
    return (
      <ErrorState
        message={connections.error}
        action={
          <Button size="sm" onClick={() => void connections.refresh()}>
            重试
          </Button>
        }
      />
    );
  }
  if (connections.data === null) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">外部连接与密钥</p>
          <p className="mt-1 text-xs text-muted-foreground">
            密钥只写入 <span className="font-mono">{connections.data.envPath ?? ".env"}</span>
            ，不会返回明文，也不会写入 YAML。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void connections.refresh()}>
          <RefreshCw /> 刷新状态
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="size-4" /> NapCat
          </CardTitle>
          <CardDescription>
            连接状态每 15 秒刷新；保存 URL/Token 后需要重启 bridge。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <StatusDot tone={tone} pulse={status?.connected === true} />
              <span className="text-sm font-medium">{statusLabel}</span>
            </div>
            <Info
              label="Bot QQ"
              value={
                status?.selfId === null || status?.selfId === undefined
                  ? "—"
                  : String(status.selfId)
              }
            />
            <Info label="最后连接" value={formatDate(status?.lastConnectedAt)} />
            <Info label="最后事件" value={formatDate(status?.lastEventAt)} />
            <div className="sm:col-span-2">
              <Info
                label="最后错误"
                value={status?.lastError ?? "—"}
                className={
                  status?.lastError === null || status?.lastError === undefined
                    ? undefined
                    : "text-destructive"
                }
              />
            </div>
          </div>

          {status?.connected === true && status.loginOk === false ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>QQ 登录态可能已失效</AlertTitle>
              <AlertDescription>
                WebSocket 仍连接，但 NapCat 的 get_login_info 失败。bridge 会自动重连
                WebSocket，但无法自动完成 QQ 登录； 请到 NapCat WebUI
                扫码或使用快速登录。保活只负责进程/连接，不代替 QQ 认证。
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              Docker Compose 已配置 <span className="font-mono">restart: unless-stopped</span>
              ，bridge 也应使用 systemd/tmux 保持运行。QQ
              会话失效时仍需要手动扫码，自动重启不会绕过登录。
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="WebSocket URL">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="ws://127.0.0.1:3001"
                aria-label="NapCat WebSocket URL"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Access Token">
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={
                  napcat?.tokenConfigured === true
                    ? "已配置，留空保持不变"
                    : "输入 NapCat Access Token"
                }
                aria-label="NapCat Access Token"
                autoComplete="new-password"
              />
            </Field>
          </div>

          <ResultAlert result={napcatResult} />

          <div className="flex justify-end">
            <Button
              disabled={napcatBusy || url.trim().length === 0}
              onClick={() => void saveNapcat()}
            >
              {napcatBusy ? <LoaderCircle className="animate-spin" /> : <PlugZap />} 保存连接配置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> Jev / Roleplay
          </CardTitle>
          <CardDescription>
            只管理 API Key；Base URL、Endpoint 和模型仍在 Roleplay 页面维护。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {jev === null ? (
            <Alert>
              <AlertTriangle />
              <AlertTitle>Roleplay 未配置</AlertTitle>
              <AlertDescription>
                当前配置没有 <span className="font-mono">plugins.roleplay</span>，因此没有 Jev
                密钥可管理。
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={jev.pluginStatus === "loaded" ? "default" : "secondary"}>
                  Roleplay{" "}
                  {jev.pluginStatus === null ? "未加载" : PLUGIN_STATUS_LABELS[jev.pluginStatus]}
                </Badge>
                <Badge variant={jev.apiKeyConfigured ? "outline" : "secondary"}>
                  {jev.apiKeyConfigured ? "密钥已配置" : "密钥未配置"}
                </Badge>
                <span className="text-muted-foreground">
                  环境变量：<span className="font-mono">{jev.apiKeyEnv}</span>
                </span>
              </div>

              <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2 xl:grid-cols-3">
                <div className="sm:col-span-2 xl:col-span-1">
                  <Info label="Base URL" value={jev.baseUrl ?? "—"} wrap />
                </div>
                <Info label="Endpoint" value={jev.endpoint ?? "—"} />
                <Info label="模型" value={jev.model ?? "—"} />
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Field label="Jev API Key">
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={
                        jev.apiKeyConfigured ? "已配置，输入新值以替换" : "输入 Jev API Key"
                      }
                      aria-label="Jev API Key"
                      autoComplete="new-password"
                    />
                  </Field>
                </div>
                <Button
                  variant="outline"
                  disabled={jevBusy || apiKey.trim().length === 0}
                  onClick={() => void saveJev()}
                >
                  {jevBusy ? <LoaderCircle className="animate-spin" /> : <KeyRound />} 保存并重载
                  Roleplay
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>端点/模型请在</span>
                <Link className="underline underline-offset-4" to="/plugins/roleplay">
                  Roleplay 页面
                </Link>
                <span>调整。</span>
              </div>
            </>
          )}
          <ResultAlert result={jevResult} />
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-2 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Info({
  label,
  value,
  className,
  wrap = false,
}: {
  label: string;
  value: string;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn("mt-0.5 font-mono text-xs", wrap ? "break-all" : "truncate", className)}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function ResultAlert({ result }: { result: ConnectionSaveResult | null }) {
  if (result === null) return null;
  const ok = result.reload === null ? true : result.reload.ok;
  return (
    <Alert variant={ok ? "default" : "destructive"}>
      {ok ? <CheckCircle2 /> : <AlertTriangle />}
      <AlertTitle>{ok ? "已保存" : "已保存，但部分操作失败"}</AlertTitle>
      <AlertDescription className="space-y-1">
        {result.restartRequired.length > 0 && (
          <p>需要重启 bridge：{result.restartRequired.join(", ")}</p>
        )}
        {result.backup !== null && <p className="font-mono text-[11px]">备份：{result.backup}</p>}
        {result.reload?.error !== undefined && <p>{result.reload.error}</p>}
        {result.warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </AlertDescription>
    </Alert>
  );
}
