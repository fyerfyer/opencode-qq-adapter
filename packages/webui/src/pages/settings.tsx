import { KeyRound, LoaderCircle, RefreshCw, Save, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, setCsrfToken } from "@/api/client";
import type { ConfigSaveResult, ConfigSnapshot, MetaInfo } from "@/api/types";
import { useAuth } from "@/auth/auth-provider";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "@/lib/utils";

export function SettingsPage() {
  const meta = useApiQuery<MetaInfo>("/meta");
  const config = useApiQuery<ConfigSnapshot>("/config");
  const [content, setContent] = useState("");
  const [hash, setHash] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ConfigSaveResult | null>(null);

  useEffect(() => {
    if (config.data !== null) {
      setContent(config.data.content);
      setHash(config.data.hash);
    }
  }, [config.data]);

  const saveConfig = async () => {
    if (config.data === null) return;
    setSaving(true);
    setResult(null);
    try {
      const response = await api.put<ConfigSaveResult>("/config", {
        content,
        expectedHash: hash,
      });
      setHash(response.hash);
      setContent(response.content);
      setResult(response);
      toast.success("配置已保存并热加载");
      await config.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    try {
      const response = await api.post<{
        ok: boolean;
        applied: string[];
        restartRequired: string[];
        error?: string;
      }>("/config/reload");
      if (response.ok) toast.success("配置已重新加载");
      else toast.error(response.error ?? "配置重载失败");
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="设置"
        description="运行时信息、YAML 配置编辑和管理员密码。"
        actions={<Badge variant="outline">本机模式</Badge>}
      />

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="security">安全</TabsTrigger>
          <TabsTrigger value="runtime">运行时</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>YAML 配置</CardTitle>
                <CardDescription>
                  {config.data?.path ?? "当前进程没有关联配置文件"} · 保存时会校验、备份并热加载。
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  <RefreshCw /> 重载
                </Button>
                <Button
                  size="sm"
                  disabled={config.data === null || saving || content === config.data.content}
                  onClick={() => void saveConfig()}
                >
                  {saving ? <LoaderCircle className="animate-spin" /> : <Save />} 保存
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {config.loading && config.data === null && <LoadingState rows={6} />}
              {config.error !== null && (
                <ErrorState
                  message={config.error}
                  action={
                    <Button size="sm" onClick={() => void config.refresh()}>
                      重试
                    </Button>
                  }
                />
              )}
              {config.data !== null && (
                <>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    spellCheck={false}
                    className="min-h-[560px] resize-y font-mono text-xs leading-6"
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>hash {hash.slice(0, 12)}…</span>
                    <span>·</span>
                    <span>mtime {formatDate(config.data.mtime)}</span>
                    <span>·</span>
                    <span>密钥请通过 `.env` 注入，不要在 YAML 里写明文。</span>
                  </div>
                  {config.data.warnings.length > 0 && (
                    <Alert>
                      <ShieldCheck />
                      <AlertTitle>配置警告</AlertTitle>
                      <AlertDescription>
                        <ul className="list-inside list-disc space-y-1">
                          {config.data.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}
                  {result !== null && (
                    <Alert variant={result.reload.ok ? "default" : "destructive"}>
                      <Terminal />
                      <AlertTitle>
                        {result.reload.ok ? "保存成功" : "已写入但热加载失败"}
                      </AlertTitle>
                      <AlertDescription className="space-y-2">
                        {result.reload.ok ? (
                          <>
                            {result.applied.length > 0 && (
                              <p>立即生效：{result.applied.join(", ")}</p>
                            )}
                            {result.restartRequired.length > 0 && (
                              <p>需要重启：{result.restartRequired.join(", ")}</p>
                            )}
                            {result.backup !== null && (
                              <p className="font-mono text-[11px]">备份：{result.backup}</p>
                            )}
                          </>
                        ) : (
                          <p>{result.reload.error ?? "未知错误"}</p>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ChangePasswordCard />
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="size-4" /> 安全模型
                </CardTitle>
                <CardDescription>管理台默认只监听 loopback。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>· 管理员密码使用 scrypt 哈希存储，浏览器只保存 HttpOnly session cookie。</p>
                <p>· 所有写操作要求 CSRF token，并校验 Origin。</p>
                <p>· 配置修改会先通过 zod + 路径校验，再备份、原子替换、热加载。</p>
                <p>
                  · 如果确实需要局域网访问，请显式开启 `admin.allow_remote` 并放在 TLS 反向代理后。
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="runtime" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>运行时</CardTitle>
              <CardDescription>版本、路径和功能开关。</CardDescription>
            </CardHeader>
            <CardContent>
              {meta.loading && meta.data === null && <LoadingState rows={4} />}
              {meta.error !== null && <ErrorState message={meta.error} />}
              {meta.data !== null && (
                <dl className="grid gap-4 sm:grid-cols-2">
                  <Info label="版本" value={meta.data.version} />
                  <Info label="配置文件" value={meta.data.configPath ?? "未关联"} mono />
                  <Info label="Prompt 目录" value={meta.data.promptRoot} mono />
                  <Info label="默认项目" value={meta.data.defaultProject ?? "未设置"} />
                  <Info label="管理员会话" value={`${meta.data.admin.sessionHours} 小时`} />
                  <Info label="远程访问" value={meta.data.admin.allowRemote ? "允许" : "仅本机"} />
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground">Features</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Object.entries(meta.data.features).map(([key, enabled]) => (
                        <Badge key={key} variant={enabled ? "default" : "secondary"}>
                          {key}: {enabled ? "on" : "off"}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChangePasswordCard() {
  const { setMustChangePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      setCsrfToken(result.csrfToken);
      setMustChangePassword(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("密码已更新，其他浏览器会话已失效");
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> 修改密码
        </CardTitle>
        <CardDescription>至少 10 个字符。修改后当前会话保留，其他会话全部失效。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="当前密码">
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="新密码">
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        <Field label="确认新密码">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          disabled={submitting || currentPassword.length === 0 || newPassword.length < 10}
          onClick={() => void submit()}
        >
          {submitting ? <LoaderCircle className="animate-spin" /> : null} 更新密码
        </Button>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-2 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
