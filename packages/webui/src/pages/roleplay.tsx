import {
  BookOpen,
  CheckCircle2,
  ImageIcon,
  Link2,
  MemoryStick,
  RefreshCw,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { MetaInfo, RoleplaySummary } from "@/api/types";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { BindingsTab } from "@/components/roleplay/bindings-tab";
import { MemoryTab } from "@/components/roleplay/memory-tab";
import { type MemoryTarget, PersonasTab } from "@/components/roleplay/personas-tab";
import { SettingsTab } from "@/components/roleplay/settings-tab";
import { StickersTab } from "@/components/roleplay/stickers-tab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/hooks/use-api-query";

export function RoleplayPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "overview";
  const meta = useApiQuery<MetaInfo>("/meta");
  const summary = useApiQuery<RoleplaySummary>("/plugins/roleplay/summary", {
    intervalMs: 30_000,
  });
  const [memoryTarget, setMemoryTarget] = useState<MemoryTarget | null>(null);
  const [stickerPersona, setStickerPersona] = useState<string | null>(null);

  const plugin = meta.data?.plugins.plugins.find((item) => item.id === "roleplay");
  const enabled = plugin?.status === "loaded";

  const setTab = (value: string) => {
    setParams(value === "overview" ? {} : { tab: value });
  };

  const openMemory = (target: MemoryTarget) => {
    setMemoryTarget(target);
    setTab("memory");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roleplay"
        description="角色卡、世界书、表情包、Markdown 记忆和 QQ 会话绑定。"
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={enabled ? "default" : "destructive"}>
              {enabled ? "插件已加载" : plugin === undefined ? "未找到插件" : plugin.status}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => void summary.refresh(true)}>
              <RefreshCw /> 刷新
            </Button>
          </div>
        }
      />

      {!enabled && (
        <Card>
          <CardHeader>
            <CardTitle>Roleplay 插件未加载</CardTitle>
            <CardDescription>
              在 YAML 的 plugins.roleplay 中启用插件，并确认 personas_dir 与 projects.roleplay.path
              一致。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {plugin?.error !== null && plugin?.error !== undefined && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                {plugin.error}
              </p>
            )}
            <p>保存配置后会自动热加载；如果失败，先看「插件」页的错误详情。</p>
            <Button variant="outline" size="sm" asChild>
              <a href="/admin/plugins">前往插件页</a>
            </Button>
          </CardContent>
        </Card>
      )}

      {enabled && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="personas">角色</TabsTrigger>
            <TabsTrigger value="stickers">表情包</TabsTrigger>
            <TabsTrigger value="memory">记忆</TabsTrigger>
            <TabsTrigger value="bindings">绑定</TabsTrigger>
            <TabsTrigger value="settings">设置</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <OverviewTab
              summary={summary}
              onOpen={(target) => {
                if (target === "personas") setTab("personas");
                if (target === "stickers") setTab("stickers");
                if (target === "memory") setTab("memory");
              }}
            />
          </TabsContent>

          <TabsContent value="personas" className="mt-4">
            <PersonasTab
              onOpenMemory={openMemory}
              onOpenStickers={(personaId) => {
                setStickerPersona(personaId);
                setTab("stickers");
              }}
            />
          </TabsContent>
          <TabsContent value="stickers" className="mt-4">
            <StickersTab initialPersonaId={stickerPersona} />
          </TabsContent>
          <TabsContent value="memory" className="mt-4">
            <MemoryTab initial={memoryTarget} />
          </TabsContent>
          <TabsContent value="bindings" className="mt-4">
            <BindingsTab />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <SettingsTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function OverviewTab({
  summary,
  onOpen,
}: {
  summary: ReturnType<typeof useApiQuery<RoleplaySummary>>;
  onOpen: (target: "personas" | "stickers" | "memory") => void;
}) {
  if (summary.loading && summary.data === null) return <LoadingState rows={6} />;
  if (summary.error !== null && summary.data === null) {
    return (
      <ErrorState
        message={summary.error}
        action={
          <Button size="sm" onClick={() => void summary.refresh()}>
            重试
          </Button>
        }
      />
    );
  }
  if (summary.data === null) return null;
  const data = summary.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="角色"
          value={data.personas.total}
          hint="Character Card 目录"
          icon={<Users />}
          onClick={() => onOpen("personas")}
        />
        <StatCard
          label="表情"
          value={data.stickers.total}
          hint={`角色 ${data.stickers.personas.length} 组 · 全局 ${data.stickers.global.count} 张`}
          icon={<ImageIcon />}
          onClick={() => onOpen("stickers")}
        />
        <StatCard
          label="记忆 scope"
          value={data.memory.scopes}
          hint="private / group / per-user"
          icon={<MemoryStick />}
          onClick={() => onOpen("memory")}
        />
        <StatCard
          label="绑定"
          value={data.bindings.total}
          hint="QQ chatKey → persona"
          icon={<Link2 />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>诊断</CardTitle>
            <CardDescription>路径、agent 和密钥检查。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.checks.map((check) => (
              <div key={check.id} className="flex items-start gap-2 rounded-lg border p-2 text-xs">
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

        <Card>
          <CardHeader>
            <CardTitle>运行信息</CardTitle>
            <CardDescription>当前插件解析后的路径和模式。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <InfoRow label="Personas" value={data.paths.personas} />
            <InfoRow label="Stickers" value={data.paths.stickers} />
            <InfoRow label="Memory" value={data.paths.memory} />
            <InfoRow label="Database" value={data.paths.database} />
            <InfoRow label="Agents" value={data.paths.agents} />
            <div className="flex flex-wrap gap-1 pt-1">
              <Badge variant="outline">judge: {data.jev.judge}</Badge>
              <Badge variant={data.jev.configured ? "default" : "secondary"}>
                Jev {data.jev.configured ? "已配置" : "未配置"}
              </Badge>
              <Badge variant={data.agents.persona ? "default" : "secondary"}>
                qq-rp {data.agents.persona ? "已安装" : "缺失"}
              </Badge>
              <Badge variant={data.agents.utility ? "default" : "secondary"}>
                utility {data.agents.utility ? "已安装" : "缺失"}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4" /> 快速开始
          </CardTitle>
          <CardDescription>第一次使用 Roleplay 的最短路径。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-3">
          <Step index={1} title="导入角色卡" description="在「角色」页上传 CCv2/V3 JSON 或 PNG。" />
          <Step
            index={2}
            title="在 QQ 中启用"
            description="发送 !persona use 角色ID，绑定和开场白会立即生效。"
          />
          <Step
            index={3}
            title="整理表情与记忆"
            description="在「表情包」上传情绪素材，在「记忆」查看/编辑 Markdown。"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon,
  onClick,
}: {
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <Card
      className={onClick === undefined ? "" : "cursor-pointer transition-colors hover:bg-muted/30"}
    >
      <CardContent className="flex items-center gap-4 p-5">
        <div className="rounded-lg border bg-muted/40 p-2.5 text-muted-foreground [&>svg]:size-4">
          {icon}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold">{value}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
  if (onClick === undefined) return content;
  return (
    <button type="button" className="text-left" onClick={onClick}>
      {content}
    </button>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-mono">{value}</span>
    </div>
  );
}

function Step({
  index,
  title,
  description,
}: {
  index: number;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-full border text-xs font-semibold">
          {index}
        </span>
        <p className="font-medium">{title}</p>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}
