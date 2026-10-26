import {
  Bot,
  CheckCircle2,
  LoaderCircle,
  Save,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { PluginOptionsSaveResult, PluginOptionsSnapshot, RoleplaySummary } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/hooks/use-api-query";
import { Field, SwitchField } from "./shared";

type Options = Record<string, unknown>;

/**
 * Mirrors `parseRoleplayOptions` defaults. The YAML often omits fields, so the
 * form must show effective values rather than 0/empty controls.
 */
const ROLEPLAY_DEFAULTS: Options = {
  project_id: "roleplay",
  agent: "qq-rp",
  model: null,
  personas_dir: null,
  default_persona: null,
  fallback_project: null,
  max_segments: 4,
  max_chars_per_segment: 180,
  delay_per_char_ms: 28,
  max_delay_ms: 2500,
  worldbook_scan_depth: 6,
  worldbook_max_entries: 4,
  worldbook_max_chars: 1200,
  worldbook_recursion_steps: 1,
  worldbook_match_whole_words: false,
  sticker_enabled: true,
  sticker_delay_ms: 600,
  sticker_cooldown_ms: 30000,
  sticker_judge: "jev",
  jev_base_url: "https://api.typesafe.ai/v1",
  jev_endpoint: "decisions",
  jev_model: "jev-latest",
  jev_api_key_env: "TYPESAFE_API_KEY",
  jev_min_confidence: 0.45,
  jev_min_sticker_ok: 0.8,
  jev_timeout_ms: 2500,
  memory_enabled: true,
  memory_utility_agent: "qq-rp-utility",
  memory_utility_model: null,
  memory_utility_timeout_ms: 90000,
  memory_consolidate_every_turns: 8,
  memory_idle_debounce_ms: 120000,
  memory_user_max_chars: 1200,
  memory_scene_max_chars: 800,
  memory_raw_top_k: 6,
  memory_raw_max_chars: 600,
  memory_max_chars: 2400,
  memory_exclude_recent: 10,
  memory_history_limit: 20,
  memory_refresh_cooldown_ms: 60000,
  install_agent: true,
  opencode_config_dir: null,
};

export function SettingsTab() {
  const snapshot = useApiQuery<PluginOptionsSnapshot>("/plugins/roleplay/options");
  const summary = useApiQuery<RoleplaySummary>("/plugins/roleplay/summary");
  const [options, setOptions] = useState<Options>({});
  const [hash, setHash] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PluginOptionsSaveResult | null>(null);

  useEffect(() => {
    if (snapshot.data !== null) {
      setOptions({ ...ROLEPLAY_DEFAULTS, ...snapshot.data.options });
      setHash(snapshot.data.configHash ?? "");
    }
  }, [snapshot.data]);

  const set = (key: string, value: unknown) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const saved = await api.put<PluginOptionsSaveResult>("/plugins/roleplay/options", {
        options,
        expectedHash: hash.length > 0 ? hash : undefined,
      });
      setOptions({ ...ROLEPLAY_DEFAULTS, ...saved.options });
      setHash(saved.configHash ?? "");
      setResult(saved);
      toast.success("Roleplay 配置已保存并热加载");
      await snapshot.refresh(true);
      await summary.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  if (snapshot.loading && snapshot.data === null) return <LoadingState rows={6} />;
  if (snapshot.error !== null && snapshot.data === null) {
    return (
      <ErrorState
        message={snapshot.error}
        action={
          <Button size="sm" onClick={() => void snapshot.refresh()}>
            重试
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{snapshot.data?.plugin.status ?? "unknown"}</Badge>
          <span>保存到 YAML 的 plugins.roleplay.options，并触发热加载。</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/agents?name=qq-rp.md">
              <Bot /> 引擎 Prompt
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings">
              <Terminal /> 编辑 YAML
            </Link>
          </Button>
          <Button size="sm" disabled={saving || snapshot.data === null} onClick={() => void save()}>
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />} 保存配置
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HealthCard
          label="qq-rp agent"
          ok={summary.data?.agents.persona ?? false}
          detail={summary.data?.paths.agents ?? "加载中…"}
        />
        <HealthCard
          label="记忆整理 agent"
          ok={summary.data?.agents.utility ?? false}
          detail={summary.data?.paths.agents ?? "加载中…"}
        />
        <HealthCard
          label="Jev 密钥"
          ok={summary.data?.jev.configured ?? false}
          detail={`${summary.data?.jev.judge ?? "-"} · ${String(options.jev_api_key_env ?? "")}`}
        />
        <HealthCard
          label="记忆目录"
          ok={summary.data?.checks.find((item) => item.id === "memory")?.ok ?? false}
          detail={summary.data?.paths.memory ?? "加载中…"}
        />
      </div>

      <Tabs defaultValue="delivery">
        <TabsList className="flex-wrap">
          <TabsTrigger value="delivery">回复</TabsTrigger>
          <TabsTrigger value="worldbook">世界书</TabsTrigger>
          <TabsTrigger value="stickers">表情</TabsTrigger>
          <TabsTrigger value="memory">记忆</TabsTrigger>
          <TabsTrigger value="project">项目与高级</TabsTrigger>
        </TabsList>

        <TabsContent value="delivery" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>分段与延迟</CardTitle>
              <CardDescription>
                QQ 没有消息编辑接口，因此用多条气泡和打字延迟模拟节奏。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <NumberField
                label="最多分段"
                value={options.max_segments}
                onChange={(value) => set("max_segments", value)}
                min={1}
                max={8}
              />
              <NumberField
                label="每段最大字数"
                value={options.max_chars_per_segment}
                onChange={(value) => set("max_chars_per_segment", value)}
                min={40}
                max={1000}
              />
              <NumberField
                label="每字延迟（ms）"
                value={options.delay_per_char_ms}
                onChange={(value) => set("delay_per_char_ms", value)}
                min={0}
                max={200}
              />
              <NumberField
                label="单段最大延迟（ms）"
                value={options.max_delay_ms}
                onChange={(value) => set("max_delay_ms", value)}
                min={0}
                max={5000}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="worldbook" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>世界书预算</CardTitle>
              <CardDescription>关键词触发、递归和 token 预算的上限。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <NumberField
                label="扫描最近消息数"
                value={options.worldbook_scan_depth}
                onChange={(value) => set("worldbook_scan_depth", value)}
                min={0}
                max={50}
              />
              <NumberField
                label="最多条目"
                value={options.worldbook_max_entries}
                onChange={(value) => set("worldbook_max_entries", value)}
                min={0}
                max={20}
              />
              <NumberField
                label="最大字符数"
                value={options.worldbook_max_chars}
                onChange={(value) => set("worldbook_max_chars", value)}
                min={0}
                max={8000}
              />
              <NumberField
                label="额外递归轮数"
                value={options.worldbook_recursion_steps}
                onChange={(value) => set("worldbook_recursion_steps", value)}
                min={0}
                max={3}
              />
              <div className="md:col-span-2 xl:col-span-4">
                <SwitchField
                  label="默认整词匹配"
                  hint="仅对没有单独设置 match_whole_words 的条目生效；中文仍按子串匹配。"
                  checked={options.worldbook_match_whole_words === true}
                  onCheckedChange={(value) => set("worldbook_match_whole_words", value)}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stickers" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>表情选择</CardTitle>
              <CardDescription>每条回复最多一张表情；tag/jev/hybrid 决定情绪来源。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="md:col-span-2 xl:col-span-4">
                <SwitchField
                  label="启用表情"
                  hint="关闭后仍会移除模型输出的 [emotion:xxx] 标签。"
                  checked={options.sticker_enabled !== false}
                  onCheckedChange={(value) => set("sticker_enabled", value)}
                />
              </div>
              <NumberField
                label="表情延迟（ms）"
                value={options.sticker_delay_ms}
                onChange={(value) => set("sticker_delay_ms", value)}
                min={200}
                max={5000}
              />
              <NumberField
                label="冷却时间（ms）"
                value={options.sticker_cooldown_ms}
                onChange={(value) => set("sticker_cooldown_ms", value)}
                min={0}
                max={600000}
              />
              <Field label="情绪判断">
                <Select
                  value={String(options.sticker_judge ?? "jev")}
                  onValueChange={(value) => set("sticker_judge", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">off</SelectItem>
                    <SelectItem value="tag">tag（只看模型标签）</SelectItem>
                    <SelectItem value="jev">jev（System One）</SelectItem>
                    <SelectItem value="hybrid">hybrid（tag 优先，再 Jev）</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Jev 端点</CardTitle>
              <CardDescription>密钥只从环境变量读取，不会写入 YAML。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <TextField
                label="Base URL"
                value={options.jev_base_url}
                onChange={(value) => set("jev_base_url", value)}
              />
              <TextField
                label="Endpoint"
                value={options.jev_endpoint}
                onChange={(value) => set("jev_endpoint", value)}
              />
              <TextField
                label="模型"
                value={options.jev_model}
                onChange={(value) => set("jev_model", value)}
              />
              <TextField
                label="密钥环境变量名"
                value={options.jev_api_key_env}
                onChange={(value) => set("jev_api_key_env", value)}
              />
              <NumberField
                label="最低 confidence"
                value={options.jev_min_confidence}
                onChange={(value) => set("jev_min_confidence", value)}
                min={0}
                max={1}
                step={0.05}
              />
              <NumberField
                label="最低 sticker_ok"
                value={options.jev_min_sticker_ok}
                onChange={(value) => set("jev_min_sticker_ok", value)}
                min={0}
                max={1}
                step={0.05}
              />
              <NumberField
                label="超时（ms）"
                value={options.jev_timeout_ms}
                onChange={(value) => set("jev_timeout_ms", value)}
                min={300}
                max={4000}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="memory" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>记忆整理</CardTitle>
              <CardDescription>
                后台 utility agent 使用 Markdown section 操作，不直接覆盖手动记忆。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="md:col-span-2 xl:col-span-4">
                <SwitchField
                  label="启用后台记忆整理"
                  hint="关闭后仍可使用 !remember 和原文 FTS 搜索。"
                  checked={options.memory_enabled !== false}
                  onCheckedChange={(value) => set("memory_enabled", value)}
                />
              </div>
              <TextField
                label="整理 agent"
                value={options.memory_utility_agent}
                onChange={(value) => set("memory_utility_agent", value)}
              />
              <TextField
                label="整理模型（可选）"
                value={options.memory_utility_model}
                onChange={(value) => set("memory_utility_model", value)}
                placeholder="provider/model"
              />
              <NumberField
                label="整理超时（ms）"
                value={options.memory_utility_timeout_ms}
                onChange={(value) => set("memory_utility_timeout_ms", value)}
                min={5000}
                max={300000}
              />
              <NumberField
                label="每 N 轮整理"
                value={options.memory_consolidate_every_turns}
                onChange={(value) => set("memory_consolidate_every_turns", value)}
                min={1}
                max={100}
              />
              <NumberField
                label="空闲 debounce（ms）"
                value={options.memory_idle_debounce_ms}
                onChange={(value) => set("memory_idle_debounce_ms", value)}
                min={0}
                max={1800000}
              />
              <NumberField
                label="刷新冷却（ms）"
                value={options.memory_refresh_cooldown_ms}
                onChange={(value) => set("memory_refresh_cooldown_ms", value)}
                min={0}
                max={3600000}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>上下文预算</CardTitle>
              <CardDescription>记忆、世界书和原文搜索会共同占用每轮上下文。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <NumberField
                label="用户文档上限"
                value={options.memory_user_max_chars}
                onChange={(value) => set("memory_user_max_chars", value)}
                min={200}
                max={4000}
              />
              <NumberField
                label="场景文档上限"
                value={options.memory_scene_max_chars}
                onChange={(value) => set("memory_scene_max_chars", value)}
                min={0}
                max={4000}
              />
              <NumberField
                label="原文 TopK"
                value={options.memory_raw_top_k}
                onChange={(value) => set("memory_raw_top_k", value)}
                min={1}
                max={20}
              />
              <NumberField
                label="原文最大字符"
                value={options.memory_raw_max_chars}
                onChange={(value) => set("memory_raw_max_chars", value)}
                min={0}
                max={4000}
              />
              <NumberField
                label="记忆总预算"
                value={options.memory_max_chars}
                onChange={(value) => set("memory_max_chars", value)}
                min={200}
                max={8000}
              />
              <NumberField
                label="排除最近消息数"
                value={options.memory_exclude_recent}
                onChange={(value) => set("memory_exclude_recent", value)}
                min={0}
                max={100}
              />
              <NumberField
                label="历史版本上限"
                value={options.memory_history_limit}
                onChange={(value) => set("memory_history_limit", value)}
                min={1}
                max={100}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="project" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>项目与角色</CardTitle>
              <CardDescription>
                这些值必须与 projects.roleplay 和 personas 目录保持一致。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <TextField
                label="Project ID"
                value={options.project_id}
                onChange={(value) => set("project_id", value)}
              />
              <TextField
                label="Agent"
                value={options.agent}
                onChange={(value) => set("agent", value)}
              />
              <TextField
                label="Model（可选）"
                value={options.model}
                onChange={(value) => set("model", value)}
                placeholder="provider/model"
              />
              <TextField
                label="Personas 目录"
                value={options.personas_dir}
                onChange={(value) => set("personas_dir", value)}
              />
              <TextField
                label="默认角色"
                value={options.default_persona}
                onChange={(value) => set("default_persona", value)}
              />
              <TextField
                label="Fallback 项目"
                value={options.fallback_project}
                onChange={(value) => set("fallback_project", value)}
              />
              <TextField
                label="OpenCode 配置目录（可选）"
                value={options.opencode_config_dir}
                onChange={(value) => set("opencode_config_dir", value)}
              />
              <div className="md:col-span-2 xl:col-span-3">
                <SwitchField
                  label="自动安装 qq-rp agent"
                  hint="首次启动时写入 ~/.config/opencode/agents/qq-rp.md 和 qq-rp-utility.md；已有用户文件不会被覆盖。"
                  checked={options.install_agent !== false}
                  onCheckedChange={(value) => set("install_agent", value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>诊断</CardTitle>
              <CardDescription>来自 roleplay 插件和当前配置的只读检查。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(summary.data?.checks ?? []).map((check) => (
                <div
                  key={check.id}
                  className="flex items-start gap-2 rounded-lg border p-2 text-xs"
                >
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 text-destructive" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium">{check.label}</p>
                    <p className="truncate text-muted-foreground">{check.detail}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {result !== null && (
        <Alert variant={result.reload.ok ? "default" : "destructive"}>
          <ShieldCheck />
          <AlertTitle>{result.reload.ok ? "已保存并热加载" : "已写入但热加载失败"}</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>立即生效：{result.applied.join(", ") || "无"}</p>
            <p>需要重启：{result.restartRequired.join(", ") || "无"}</p>
            {result.backup !== null && (
              <p className="font-mono text-[11px]">备份：{result.backup}</p>
            )}
            {!result.reload.ok && <p>{result.reload.error ?? "未知错误"}</p>}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <Input
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: unknown;
  onChange: (value: number | string) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={typeof value === "number" ? value : Number(value ?? 0)}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === "" ? raw : Number(raw));
        }}
      />
    </Field>
  );
}

function HealthCard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="size-4 text-emerald-600" />
        ) : (
          <XCircle className="size-4 text-destructive" />
        )}
        <p className="text-sm font-medium">{label}</p>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}
