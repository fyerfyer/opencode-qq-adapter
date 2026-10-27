import {
  Bot,
  Check,
  ChevronDown,
  FileClock,
  FileText,
  History,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type {
  AgentModelRecord,
  PromptBackup,
  PromptFile,
  PromptOwner,
  PromptSummary,
} from "@/api/types";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "@/lib/utils";

const TEMPLATE = `---
description: QQ remote coding agent
mode: primary
permissions:
  - action: external_directory
    resource: "*"
    effect: deny
  - action: read
    resource: "*.env"
    effect: deny
---

You are an expert software engineering agent running through a QQ chat.

- Work directly in the workspace and follow the project's existing patterns.
- Never reveal secrets, tokens, or .env contents.
- Keep answers concise. QQ renders limited Markdown.
- Use the qq_send_image / qq_send_file tools when the user asks for media.
`;

const OWNER_GROUPS: Array<{
  owner: PromptOwner;
  label: string;
  description: string;
}> = [
  {
    owner: "core",
    label: "核心管理",
    description: "opencode-qq-adapter 创建的 agent，可直接编辑并保留版本备份。",
  },
  {
    owner: "plugin",
    label: "插件管理",
    description: "由插件安装和升级；默认只读，避免与插件版本漂移。",
  },
  {
    owner: "user",
    label: "其他 Agents",
    description: "你自己或其他工具创建的 OpenCode agent。",
  },
];

export function AgentsPage() {
  const list = useApiQuery<{ root: string; prompts: PromptSummary[] }>("/prompts");
  const models = useApiQuery<{ models: AgentModelRecord[] }>("/models");
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedName = searchParams.get("name");
  const [selectedName, setSelectedName] = useState<string | null>(requestedName);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [override, setOverride] = useState(false);
  const prompt = useApiQuery<PromptFile>(
    selectedName === null ? null : `/prompts/${encodeURIComponent(selectedName)}`,
  );

  const selectPrompt = useCallback(
    (name: string | null) => {
      setSelectedName(name);
      setOverride(false);
      if (name === null) setSearchParams({});
      else setSearchParams({ name });
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (requestedName !== null && requestedName !== selectedName) {
      setSelectedName(requestedName);
      setOverride(false);
    }
  }, [requestedName, selectedName]);

  useEffect(() => {
    if (list.data !== null && selectedName === null && list.data.prompts.length > 0) {
      selectPrompt(list.data.prompts[0]?.name ?? null);
    }
  }, [list.data, selectedName, selectPrompt]);

  const groups = useMemo(
    () =>
      OWNER_GROUPS.map((group) => ({
        ...group,
        prompts: (list.data?.prompts ?? []).filter((item) => item.owner === group.owner),
      })).filter((group) => group.prompts.length > 0),
    [list.data?.prompts],
  );

  useEffect(() => {
    if (prompt.data !== null) {
      setDraft(prompt.data.content);
      setOriginal(prompt.data.content);
    }
  }, [prompt.data]);

  const dirty = draft !== original;
  const selected =
    prompt.data ?? list.data?.prompts.find((item) => item.name === selectedName) ?? null;
  const locked = selected !== null && !selected.editable && !override;
  const modelList = (models.data?.models ?? []).filter((model) => model.enabled);

  const save = async () => {
    if (selectedName === null || locked) return;
    setSaving(true);
    try {
      const result = await api.put<PromptFile>(`/prompts/${encodeURIComponent(selectedName)}`, {
        content: draft,
        override: selected !== null && !selected.editable,
      });
      setOriginal(result.content);
      toast.success("Agent 已保存，旧版本已备份");
      await list.refresh(true);
      await prompt.refresh(true);
      await reloadOpenCode();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const changeModel = async (value: string) => {
    if (selectedName === null || locked || saving) return;
    setSaving(true);
    try {
      const result = await api.put<{
        prompt: PromptFile;
        reload: { ok: boolean; warnings: string[]; error?: string };
      }>(`/prompts/${encodeURIComponent(selectedName)}/model`, {
        model: value === "__inherit" ? null : value,
        override: selected !== null && !selected.editable,
      });
      setDraft(result.prompt.content);
      setOriginal(result.prompt.content);
      if (result.reload.ok) {
        toast.success("模型已保存，OpenCode 配置已热重载");
      } else {
        toast.warning(`模型已保存，但 OpenCode 重载失败：${result.reload.error ?? "未知错误"}`);
      }
      await list.refresh(true);
      await prompt.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const reloadOpenCode = async () => {
    try {
      const result = await api.post<{ ok: boolean; error?: string }>("/opencode/reload");
      if (!result.ok) {
        toast.warning(`Agent 已保存，但 OpenCode 重载失败：${result.error ?? "未知错误"}`);
      }
    } catch (caught) {
      toast.warning(`Agent 已保存，但 OpenCode 重载失败：${errorMessage(caught)}`);
    }
  };

  const create = async (name: string, content: string) => {
    try {
      await api.put(`/prompts/${encodeURIComponent(name)}`, { content });
      toast.success("Agent 已创建");
      setCreateOpen(false);
      selectPrompt(name);
      await list.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="管理 OpenCode 全局 agents。核心 agent 可编辑；插件管理的 agent 默认只读，需要高级覆盖。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void list.refresh()}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> 新建 Agent
            </Button>
          </>
        }
      />

      {list.error !== null && (
        <ErrorState
          message={list.error}
          action={
            <Button size="sm" onClick={() => void list.refresh()}>
              重试
            </Button>
          }
        />
      )}

      <Card className="sticky top-0 z-20 border bg-background/95 shadow-sm backdrop-blur">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="size-4 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">默认模型</p>
              <p className="text-xs text-muted-foreground">
                写入当前 Agent 的 frontmatter；选择后立即保存并热重载 OpenCode。
              </p>
            </div>
          </div>
          <ModelPicker
            value={selected?.model ?? null}
            models={modelList}
            fallbackModel={
              selected?.model !== null &&
              selected?.model !== undefined &&
              !modelList.some((model) => model.id === selected.model)
                ? selected.model
                : null
            }
            disabled={
              selectedName === null ||
              locked ||
              saving ||
              dirty ||
              models.loading ||
              models.error !== null
            }
            onChange={(value) => void changeModel(value)}
          />
          {models.error !== null && (
            <span className="text-xs text-destructive">模型列表不可用：{models.error}</span>
          )}
          {models.data !== null && modelList.length === 0 && models.error === null && (
            <span className="text-xs text-muted-foreground">OpenCode 没有返回可用模型。</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4" /> 当前 Agent
          </CardTitle>
          <CardDescription className="break-all font-mono text-[11px]">
            {list.data?.root ?? "加载中…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.loading && list.data === null ? (
            <LoadingState rows={2} />
          ) : (list.data?.prompts.length ?? 0) === 0 ? (
            <EmptyState
              title="没有 agent"
              description="创建 qq-code.md 以定制 QQ 侧行为。"
              icon={<FileText />}
            />
          ) : (
            <>
              <Select
                value={selectedName ?? undefined}
                onValueChange={(value) => selectPrompt(value)}
              >
                <SelectTrigger className="w-full max-w-xl">
                  <SelectValue placeholder="选择一个 Agent" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectGroup key={group.owner}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.prompts.map((item) => (
                        <SelectItem key={item.name} value={item.name}>
                          <span className="font-mono text-xs">{item.name}</span>
                          {item.owner === "plugin" && (
                            <LockKeyhole className="size-3 text-muted-foreground" />
                          )}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {selected !== null && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">{ownerLabel(selected.owner)}</Badge>
                  {selected.managedBy !== null && (
                    <span className="font-mono text-[10px]">{selected.managedBy}</span>
                  )}
                  <span>{selected.description ?? selected.title ?? `${selected.size} bytes`}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <span className="truncate font-mono text-base">{selectedName ?? "选择 Agent"}</span>
              {dirty && (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 text-amber-600 dark:text-amber-400"
                >
                  未保存
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="space-y-1">
              <span className="block">
                {prompt.data === null
                  ? "从上方选择 Agent"
                  : `更新于 ${formatDate(prompt.data.updatedAt)} · ${prompt.data.size} bytes`}
              </span>
              {selected !== null && (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{ownerLabel(selected.owner)}</Badge>
                  {selected.managedBy !== null && (
                    <span className="font-mono text-[10px]">{selected.managedBy}</span>
                  )}
                  <Badge variant="secondary">{selected.model ?? "默认模型"}</Badge>
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {selectedName !== null && (
              <Button variant="outline" size="sm" onClick={() => setBackupOpen(true)}>
                <History /> 版本
              </Button>
            )}
            <Button
              size="sm"
              disabled={selectedName === null || !dirty || saving || locked}
              onClick={() => void save()}
            >
              <Save /> 保存
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {selectedName === null ? (
            <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              选择一个 Agent 开始编辑
            </div>
          ) : prompt.loading && prompt.data === null ? (
            <Skeleton className="h-[520px] w-full rounded-lg" />
          ) : prompt.error !== null ? (
            <ErrorState
              message={prompt.error}
              action={
                <Button size="sm" onClick={() => void prompt.refresh()}>
                  重试
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              {selected !== null && selected.owner === "plugin" && (
                <Alert variant={override ? "destructive" : "default"}>
                  <ShieldCheck />
                  <AlertTitle className="flex items-center gap-2">
                    {override ? "高级覆盖已开启" : "此 Agent 由插件管理"}
                    <Badge variant="outline">{selected.managedBy ?? "plugin"}</Badge>
                  </AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>
                      {override
                        ? "保存后插件升级不会覆盖你的修改；请注意与插件默认 prompt 的版本漂移。"
                        : "默认只读。角色卡、备注、世界书和记忆请在 Roleplay 页面编辑；只有确实要调整引擎规则时才开启高级覆盖。"}
                    </p>
                    <div className="flex items-center gap-2">
                      <Switch checked={override} onCheckedChange={setOverride} />
                      <span className="text-xs">允许高级覆盖</span>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                readOnly={locked}
                spellCheck={false}
                className={`min-h-[520px] resize-y font-mono text-xs leading-6 ${
                  locked ? "cursor-not-allowed opacity-70" : ""
                }`}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {createOpen && <CreatePromptDialog onClose={() => setCreateOpen(false)} onCreate={create} />}
      {backupOpen && selectedName !== null && (
        <BackupSheet
          name={selectedName}
          override={override}
          locked={selected !== null && !selected.editable && !override}
          onClose={() => setBackupOpen(false)}
          onRestored={async () => {
            setBackupOpen(false);
            await list.refresh(true);
            await prompt.refresh(true);
          }}
        />
      )}
    </div>
  );
}

function ModelPicker({
  value,
  models,
  fallbackModel,
  disabled,
  onChange,
}: {
  value: string | null;
  models: AgentModelRecord[];
  fallbackModel: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const options = useMemo(() => {
    const list = models.map((model) => ({ id: model.id, name: model.name }));
    if (fallbackModel !== null && !list.some((model) => model.id === fallbackModel)) {
      list.unshift({ id: fallbackModel, name: "当前配置" });
    }
    return list;
  }, [models, fallbackModel]);
  const query = search.trim().toLowerCase();
  const filtered =
    query.length === 0
      ? options
      : options.filter(
          (model) =>
            model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
        );
  const label = value ?? "继承 OpenCode 默认";

  const select = (next: string | null) => {
    setOpen(false);
    setSearch("");
    onChange(next ?? "__inherit");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label="Agent 默认模型"
          aria-expanded={open}
          disabled={disabled}
          className="w-full max-w-md justify-between font-normal"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(32rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="sticky top-0 z-10 border-b bg-popover p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索模型 ID 或名称…"
              aria-label="搜索模型"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        <div
          className="max-h-72 overflow-y-auto overscroll-contain p-1"
          role="listbox"
          aria-label="模型列表"
        >
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => select(null)}
          >
            <Check className={`size-4 shrink-0 ${value === null ? "opacity-100" : "opacity-0"}`} />
            继承 OpenCode 默认
          </button>
          {filtered.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={value === model.id}
              className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => select(model.id)}
            >
              <Check
                className={`mt-0.5 size-4 shrink-0 ${
                  value === model.id ? "opacity-100" : "opacity-0"
                }`}
              />
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs">{model.id}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {model.name}
                </span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的模型。</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ownerLabel(owner: PromptOwner): string {
  if (owner === "core") return "core";
  if (owner === "plugin") return "plugin";
  return "user";
}

function CreatePromptDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, content: string) => void;
}) {
  const [name, setName] = useState("custom-agent.md");
  const [content, setContent] = useState(TEMPLATE);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建 Agent</DialogTitle>
          <DialogDescription>
            文件名必须是扁平 `*.md`，保存到 OpenCode 全局 agents
            目录。插件管理的同名文件不会被覆盖，除非显式高级覆盖。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="mb-2 block text-xs text-muted-foreground">文件名</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div>
            <Label className="mb-2 block text-xs text-muted-foreground">初始内容</Label>
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="min-h-[260px] font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.endsWith(".md")} onClick={() => onCreate(name, content)}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackupSheet({
  name,
  override,
  locked,
  onClose,
  onRestored,
}: {
  name: string;
  override: boolean;
  locked: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const backups = useApiQuery<{ backups: PromptBackup[] }>(
    `/prompts/${encodeURIComponent(name)}/backups`,
  );
  const [preview, setPreview] = useState<{ backup: string; content: string } | null>(null);

  const loadPreview = async (backup: string) => {
    try {
      const result = await api.get<{ content: string }>(
        `/prompts/${encodeURIComponent(name)}/backups/${encodeURIComponent(backup)}`,
      );
      setPreview({ backup, content: result.content });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const restore = async (backup: string) => {
    try {
      await api.post(`/prompts/${encodeURIComponent(name)}/restore`, { backup, override });
      toast.success("已恢复到该备份");
      onRestored();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>版本历史</SheetTitle>
          <SheetDescription>{name} · 每次保存前自动创建备份</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          {locked && (
            <Alert>
              <ShieldCheck />
              <AlertTitle>先开启高级覆盖</AlertTitle>
              <AlertDescription>
                插件管理的 agent 默认只读；恢复历史版本也需要高级覆盖。
              </AlertDescription>
            </Alert>
          )}
          {backups.loading && backups.data === null && <LoadingState rows={3} />}
          {backups.error !== null && <ErrorState message={backups.error} />}
          {backups.data?.backups.length === 0 && (
            <EmptyState
              title="还没有备份"
              description="第一次保存后会出现版本记录。"
              icon={<FileClock />}
            />
          )}
          {backups.data !== null && backups.data.backups.length > 0 && (
            <ScrollArea className="h-[calc(100vh-10rem)] pr-3">
              <div className="space-y-2">
                {backups.data.backups.map((backup) => (
                  <div
                    key={backup.name}
                    className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">{backup.name}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatDate(backup.updatedAt)} · {backup.size} bytes
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void loadPreview(backup.name)}
                      >
                        预览
                      </Button>
                      <Button size="sm" disabled={locked} onClick={() => void restore(backup.name)}>
                        恢复
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
        {preview !== null && (
          <Dialog open onOpenChange={(open) => !open && setPreview(null)}>
            <DialogContent className="sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle className="font-mono text-base">{preview.backup}</DialogTitle>
                <DialogDescription>只读预览</DialogDescription>
              </DialogHeader>
              <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
                {preview.content}
              </pre>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  关闭
                </Button>
                <Button disabled={locked} onClick={() => void restore(preview.backup)}>
                  恢复此版本
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </SheetContent>
    </Sheet>
  );
}
