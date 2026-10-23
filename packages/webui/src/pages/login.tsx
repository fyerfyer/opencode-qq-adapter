import {
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MessagesSquare,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/auth-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const features = [
  {
    icon: MessagesSquare,
    title: "会话与运行",
    description: "查看 QQ ↔ OpenCode 绑定、活跃 run 和项目 session。",
  },
  {
    icon: ShieldCheck,
    title: "访问与策略",
    description: "编辑用户、群、项目和权限规则，变更先校验再热加载。",
  },
  { icon: Database, title: "审计与用量", description: "追踪登录、审批、拒绝和每日 token / cost。" },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      navigate("/", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-zinc-950 p-10 text-zinc-50 lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div className="login-grid pointer-events-none absolute inset-0 opacity-[0.07]" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border border-white/20 bg-white text-sm font-bold text-zinc-950">
              Q
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">OpenCode QQ</p>
              <p className="text-xs text-zinc-400">Admin console</p>
            </div>
          </div>
          <div className="mt-16 max-w-md space-y-5">
            <p className="text-xs font-medium tracking-[0.2em] text-zinc-500 uppercase">
              Local control surface
            </p>
            <h1 className="text-4xl leading-tight font-semibold tracking-tight">
              管理 QQ 上的
              <br />
              coding agent。
            </h1>
            <p className="text-sm leading-7 text-zinc-400">
              一个只监听本机的管理台：配置用户与项目，查看运行和审计，编辑 Prompt。 YAML
              仍然是唯一配置源。
            </p>
          </div>
        </div>
        <div className="relative space-y-4">
          {features.map((feature) => (
            <div key={feature.title} className="flex gap-3">
              <feature.icon className="mt-0.5 size-4 shrink-0 text-zinc-500" />
              <div>
                <p className="text-sm font-medium">{feature.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-zinc-500">{feature.description}</p>
              </div>
            </div>
          ))}
          <p className="pt-3 text-[11px] text-zinc-600">
            opencode-qq-adapter · 本机管理工具，不暴露公网
          </p>
        </div>
      </aside>

      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-foreground text-sm font-bold text-background">
              Q
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">OpenCode QQ</p>
              <p className="text-xs text-muted-foreground">Admin console</p>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">登录</h2>
            <p className="text-sm text-muted-foreground">使用终端里生成的管理员密码进入管理台。</p>
          </div>

          <form className="mt-7 space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="password">管理员密码</Label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  className="pl-9"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••••••"
                />
              </div>
            </div>
            {error !== null && (
              <Alert variant="destructive">
                <KeyRound />
                <AlertTitle>登录失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={submitting || password.length === 0}>
              {submitting ? <LoaderCircle className="animate-spin" /> : null}
              进入管理台
            </Button>
          </form>

          <div className="mt-8 border-t pt-5 text-xs leading-6 text-muted-foreground">
            <p className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
              <Terminal className="size-3.5" /> 第一次使用？
            </p>
            首次启动会把随机密码打印到 bridge 日志。如果错过了：
            <code className="mt-2 block rounded-md border bg-muted/50 px-2.5 py-2 font-mono text-[11px]">
              opencode-qq admin reset-password -c config/config.yaml
            </code>
          </div>
        </div>
      </main>
    </div>
  );
}
