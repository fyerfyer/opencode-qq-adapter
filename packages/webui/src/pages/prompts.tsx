import { FileClock, FileText, History, Plus, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { PromptBackup, PromptFile, PromptSummary } from "@/api/types";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
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

export function PromptsPage() {
  const list = useApiQuery<{ root: string; prompts: PromptSummary[] }>("/prompts");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const prompt = useApiQuery<PromptFile>(
    selectedName === null ? null : `/prompts/${encodeURIComponent(selectedName)}`,
  );

  useEffect(() => {
    if (list.data !== null && selectedName === null && list.data.prompts.length > 0) {
      setSelectedName(list.data.prompts[0]?.name ?? null);
    }
  }, [list.data, selectedName]);

  useEffect(() => {
    if (prompt.data !== null) {
      setDraft(prompt.data.content);
      setOriginal(prompt.data.content);
    }
  }, [prompt.data]);

  const dirty = draft !== original;

  const save = async () => {
    if (selectedName === null) return;
    setSaving(true);
    try {
      const result = await api.put<PromptFile>(`/prompts/${encodeURIComponent(selectedName)}`, {
        content: draft,
      });
      setOriginal(result.content);
      toast.success("Prompt 已保存，旧版本已备份");
      await list.refresh(true);
      await prompt.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const create = async (name: string, content: string) => {
    try {
      await api.put(`/prompts/${encodeURIComponent(name)}`, { content });
      toast.success("Prompt 已创建");
      setCreateOpen(false);
      setSelectedName(name);
      await list.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prompt"
        description="编辑 OpenCode 全局 agents 目录下的 Markdown prompt。保存前自动备份。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void list.refresh()}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> 新建 Prompt
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

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4" /> 文件
            </CardTitle>
            <CardDescription className="break-all font-mono text-[11px]">
              {list.data?.root ?? "加载中…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {list.loading && list.data === null && <LoadingState rows={4} />}
            {list.data?.prompts.length === 0 && (
              <EmptyState
                title="没有 prompt"
                description="创建 qq-code.md 以定制 QQ 侧行为。"
                icon={<FileText />}
              />
            )}
            {list.data?.prompts.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => setSelectedName(item.name)}
                className={`flex w-full flex-col rounded-lg border px-3 py-2 text-left transition ${
                  selectedName === item.name
                    ? "border-foreground/20 bg-accent"
                    : "border-transparent hover:bg-muted/60"
                }`}
              >
                <span className="truncate font-mono text-xs font-medium">{item.name}</span>
                <span className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {item.description ?? item.title ?? `${item.size} bytes`}
                </span>
                {item.backups > 0 && (
                  <span className="mt-1 text-[10px] text-muted-foreground">
                    {item.backups} 个备份
                  </span>
                )}
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <span className="truncate font-mono text-base">
                  {selectedName ?? "选择 Prompt"}
                </span>
                {dirty && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 text-amber-600 dark:text-amber-400"
                  >
                    未保存
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {prompt.data === null
                  ? "从左侧选择文件"
                  : `更新于 ${formatDate(prompt.data.updatedAt)} · ${prompt.data.size} bytes`}
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
                disabled={selectedName === null || !dirty || saving}
                onClick={() => void save()}
              >
                <Save /> 保存
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {selectedName === null ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                选择一个 Prompt 开始编辑
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
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                className="min-h-[520px] resize-y font-mono text-xs leading-6"
              />
            )}
          </CardContent>
        </Card>
      </div>

      {createOpen && <CreatePromptDialog onClose={() => setCreateOpen(false)} onCreate={create} />}
      {backupOpen && selectedName !== null && (
        <BackupSheet
          name={selectedName}
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

function CreatePromptDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, content: string) => void;
}) {
  const [name, setName] = useState("qq-code.md");
  const [content, setContent] = useState(TEMPLATE);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建 Prompt</DialogTitle>
          <DialogDescription>
            文件名必须是扁平 `*.md`，保存到 OpenCode 全局 agents 目录。
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
  onClose,
  onRestored,
}: {
  name: string;
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
      await api.post(`/prompts/${encodeURIComponent(name)}/restore`, { backup });
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
        <div className="mt-4">
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
                      <Button size="sm" onClick={() => void restore(backup.name)}>
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
                <Button onClick={() => void restore(preview.backup)}>恢复此版本</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </SheetContent>
    </Sheet>
  );
}
