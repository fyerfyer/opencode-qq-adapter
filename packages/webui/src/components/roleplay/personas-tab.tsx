import { BookOpen, IdCard, Import, LoaderCircle, MemoryStick, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type {
  RoleplayMemoryScope,
  RoleplayPersonaDetail,
  RoleplayPersonaSummary,
  RoleplayWorldbookEntry,
} from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { ErrorState, LoadingState } from "@/components/common/data-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "@/lib/utils";
import { EmptyHint, Field, MarkdownEditor } from "./shared";

export interface MemoryTarget {
  personaId: string;
  scope: string;
  kind: "user" | "scene";
  actorQq: number;
}

export function PersonasTab({
  onOpenMemory,
  onOpenStickers,
}: {
  onOpenMemory: (target: MemoryTarget) => void;
  onOpenStickers?: (personaId: string) => void;
}) {
  const { data, error, loading, refresh } = useApiQuery<{ personas: RoleplayPersonaSummary[] }>(
    "/plugins/roleplay/personas",
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importId, setImportId] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const dropzone = useDropzone({
    accept: {
      "application/json": [".json"],
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "application/octet-stream": [".charx"],
      "application/zip": [".charx"],
    },
    maxFiles: 1,
    onDrop: (accepted) => setFile(accepted[0] ?? null),
  });

  const personas = useMemo(() => {
    const target = query.trim().toLowerCase();
    if (target.length === 0) return data?.personas ?? [];
    return (data?.personas ?? []).filter(
      (persona) =>
        persona.id.toLowerCase().includes(target) ||
        persona.name.toLowerCase().includes(target) ||
        persona.description.toLowerCase().includes(target),
    );
  }, [data?.personas, query]);

  const importCard = async () => {
    if (file === null) {
      toast.error("请选择角色卡文件");
      return;
    }
    setImporting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      if (importId.trim().length > 0) form.append("id", importId.trim());
      const result = await api.upload<{
        persona: { id: string; name: string };
        worldbook: number;
        stickerCount: number;
      }>("/plugins/roleplay/personas/import", form);
      toast.success(
        `已导入 ${result.persona.name}：世界书 ${result.worldbook} 条，表情 ${result.stickerCount} 张`,
      );
      setImportOpen(false);
      setFile(null);
      setImportId("");
      await refresh(true);
      setSelected(result.persona.id);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setImporting(false);
    }
  };

  if (loading && data === null) return <LoadingState rows={5} />;
  if (error !== null && data === null) {
    return (
      <ErrorState
        message={error}
        action={
          <Button size="sm" onClick={() => void refresh()}>
            重试
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索角色名、ID 或描述"
          />
        </div>
        <Badge variant="secondary">{personas.length} 个角色</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh(true)}>
            刷新
          </Button>
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Import /> 导入角色卡
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>导入 Character Card</DialogTitle>
                <DialogDescription>
                  支持 V2/V3 JSON、PNG 和 CharX。导入会覆盖同 ID 的角色目录。
                </DialogDescription>
              </DialogHeader>
              <div
                {...dropzone.getRootProps()}
                className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/20 p-6 text-center text-sm transition-colors hover:bg-muted/40 data-[active=true]:border-foreground"
                data-active={dropzone.isDragActive}
              >
                <input {...dropzone.getInputProps()} />
                <IdCard className="size-6 text-muted-foreground" />
                <p>{file === null ? "拖入文件或点击选择" : file.name}</p>
                <p className="text-[11px] text-muted-foreground">最大 25 MiB</p>
              </div>
              <Field label="角色 ID（可选）" hint="留空时由卡片名生成；建议使用小写英文 ID。">
                <Input
                  value={importId}
                  onChange={(event) => setImportId(event.target.value)}
                  placeholder="blue-fat-fish"
                />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setImportOpen(false)}>
                  取消
                </Button>
                <Button disabled={importing || file === null} onClick={() => void importCard()}>
                  {importing ? <LoaderCircle className="animate-spin" /> : <Import />} 导入
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {personas.length === 0 ? (
        <EmptyHint
          title={query.length > 0 ? "没有匹配的角色" : "还没有角色卡"}
          description={
            query.length > 0
              ? "换个关键词试试。"
              : "导入 Character Card V2/V3，或把卡片放到 personas 目录后刷新。"
          }
          icon={<IdCard className="size-5" />}
          action={
            <Button size="sm" onClick={() => setImportOpen(true)}>
              <Import /> 导入第一张卡
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {personas.map((persona) => (
            <button
              key={persona.id}
              type="button"
              onClick={() => setSelected(persona.id)}
              className="group flex gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/30"
            >
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted text-lg font-semibold">
                {persona.avatarUrl === null ? (
                  persona.name.slice(0, 1)
                ) : (
                  <img
                    src={`${persona.avatarUrl}?v=${persona.updatedAt}`}
                    alt={persona.name}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{persona.name}</p>
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                    {persona.id}
                  </Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {persona.description || "（没有描述）"}
                </p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{persona.worldbook} 世界书</span>
                  <span>{persona.stickers} 表情</span>
                  <span>{persona.memoryScopes} 记忆</span>
                  <span>{persona.bindings} 绑定</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <PersonaSheet
          id={selected}
          onClose={() => setSelected(null)}
          onOpenMemory={(target) => {
            setSelected(null);
            onOpenMemory(target);
          }}
          onOpenStickers={onOpenStickers}
          onChanged={() => void refresh(true)}
        />
      )}
    </div>
  );
}

function PersonaSheet({
  id,
  onClose,
  onChanged,
  onOpenMemory,
  onOpenStickers,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenMemory: (target: MemoryTarget) => void;
  onOpenStickers?: (personaId: string) => void;
}) {
  const { data, error, loading, refresh } = useApiQuery<RoleplayPersonaDetail>(
    `/plugins/roleplay/personas/${encodeURIComponent(id)}`,
  );
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [worldbookQuery, setWorldbookQuery] = useState("");
  const [worldbookResult, setWorldbookResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (data !== null) setNotes(data.notes);
  }, [data]);

  const saveNotes = async () => {
    setSaving(true);
    try {
      await api.put(`/plugins/roleplay/personas/${encodeURIComponent(id)}/notes`, { notes });
      toast.success("角色备注已保存，AGENTS.md 已重新生成");
      await refresh(true);
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const checkWorldbook = async () => {
    if (worldbookQuery.trim().length === 0) return;
    setChecking(true);
    setWorldbookResult(null);
    try {
      const result = await api.get<{ text: string }>(
        `/plugins/roleplay/personas/${encodeURIComponent(id)}/worldbook/check?text=${encodeURIComponent(worldbookQuery)}`,
      );
      setWorldbookResult(result.text);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/plugins/roleplay/personas/${encodeURIComponent(id)}`);
      toast.success("角色已删除");
      onClose();
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-hidden rounded-l-2xl border-l-0 bg-background/95 p-0 shadow-[-32px_0_64px_-32px_rgba(0,0,0,0.32)] backdrop-blur-xl sm:max-w-3xl">
        <SheetHeader className="border-b border-border/50 px-6 pt-6 pr-14 pb-4">
          <SheetTitle>{data?.persona.name ?? id}</SheetTitle>
          <SheetDescription className="truncate">
            {data?.persona.dir ?? "加载角色详情…"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading && data === null && <LoadingState rows={5} />}
          {error !== null && <ErrorState message={error} />}
          {data !== null && (
            <Tabs defaultValue="card">
              <TabsList className="flex-wrap rounded-xl bg-muted/60 p-1">
                <TabsTrigger value="card" className="rounded-lg">
                  角色卡
                </TabsTrigger>
                <TabsTrigger value="notes" className="rounded-lg">
                  备注
                </TabsTrigger>
                <TabsTrigger value="worldbook" className="rounded-lg">
                  世界书
                </TabsTrigger>
                <TabsTrigger value="memory" className="rounded-lg">
                  记忆
                </TabsTrigger>
                <TabsTrigger value="bindings" className="rounded-lg">
                  绑定
                </TabsTrigger>
              </TabsList>

              <TabsContent value="card" className="mt-4">
                <ScrollArea className="h-[calc(100vh-13rem)] pr-3">
                  <div className="space-y-5 pb-2">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Info label="角色 ID" value={data.persona.id} mono />
                      <Info label="更新时间" value={formatDate(data.persona.updatedAt)} />
                      <Info label="世界书" value={`${data.worldbook.length} 条`} />
                      <Info
                        label="表情"
                        value={`${data.stickers.total} 张 / ${data.stickers.emotions.length} 情绪`}
                      />
                    </div>
                    {onOpenStickers !== undefined && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onClose();
                          onOpenStickers(data.persona.id);
                        }}
                      >
                        管理这个角色的表情包
                      </Button>
                    )}
                    {data.card === null ? (
                      <p className="text-sm text-muted-foreground">card.json 不可读。</p>
                    ) : (
                      <div className="space-y-3">
                        <Preview title="描述" value={data.card.description} />
                        <Preview title="性格" value={data.card.personality} />
                        <Preview title="场景" value={data.card.scenario} />
                        <Preview title="开场白" value={data.card.first_mes} />
                        {data.card.alternate_greetings !== undefined &&
                          data.card.alternate_greetings.length > 0 && (
                            <div className="rounded-lg border p-3">
                              <p className="text-xs text-muted-foreground">备选开场白</p>
                              <div className="mt-2 space-y-2">
                                {data.card.alternate_greetings.map((greeting) => (
                                  <p key={greeting} className="whitespace-pre-wrap text-sm">
                                    {greeting}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}
                        {data.card.tags !== undefined && data.card.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {data.card.tags.map((tag) => (
                              <Badge key={tag} variant="secondary">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="notes" className="mt-4 space-y-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  这里的内容会写入 notes.md，并重新生成 AGENTS.md
                  的「用户补充」段落；不会修改角色卡原始字段。
                </p>
                <MarkdownEditor
                  value={notes}
                  onChange={setNotes}
                  placeholder="例如：她更喜欢短句，不要替用户做决定。"
                  minHeight="20rem"
                />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setNotes(data.notes)}>
                    重置
                  </Button>
                  <Button size="sm" disabled={saving} onClick={() => void saveNotes()}>
                    {saving ? <LoaderCircle className="animate-spin" /> : null} 保存备注
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="worldbook" className="mt-4 space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={worldbookQuery}
                    onChange={(event) => setWorldbookQuery(event.target.value)}
                    placeholder="输入一句话，调试关键词/递归/预算命中"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void checkWorldbook();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checking}
                    onClick={() => void checkWorldbook()}
                  >
                    {checking ? <LoaderCircle className="animate-spin" /> : <Search />} 检查
                  </Button>
                </div>
                {worldbookResult !== null && (
                  <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs leading-5 whitespace-pre-wrap">
                    {worldbookResult}
                  </pre>
                )}
                {data.worldbook.length === 0 ? (
                  <EmptyHint
                    title="世界书为空"
                    description="这张卡没有 Character Book 条目。"
                    icon={<BookOpen />}
                  />
                ) : (
                  <div className="space-y-2.5">
                    {data.worldbook.map((entry) => (
                      <WorldbookRow key={`${entry.name}-${entry.insertionOrder}`} entry={entry} />
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="memory" className="mt-4 space-y-2">
                {data.memoryScopes.length === 0 ? (
                  <EmptyHint
                    title="还没有记忆"
                    description="先在 QQ 中与这个角色聊天，或使用 !remember 写入手动记忆。"
                    icon={<MemoryStick />}
                  />
                ) : (
                  data.memoryScopes.map((scope) => (
                    <ScopeRow
                      key={scope.scope}
                      scope={scope}
                      onOpen={(kind, actorQq) =>
                        onOpenMemory({ personaId: id, scope: scope.scope, kind, actorQq })
                      }
                    />
                  ))
                )}
              </TabsContent>

              <TabsContent value="bindings" className="mt-4 space-y-2">
                {data.bindings.length === 0 ? (
                  <EmptyHint
                    title="没有绑定"
                    description="在 QQ 私聊或群聊中发送 !persona use 角色ID 即可绑定。"
                    icon={<Users />}
                  />
                ) : (
                  data.bindings.map((binding) => (
                    <div key={binding.chatKey} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-xs">{binding.chatKey}</code>
                        <Badge variant={binding.enabled ? "default" : "secondary"}>
                          {binding.enabled ? "开启" : "关闭"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        原项目：{binding.previousProjectId ?? "无"} · 更新{" "}
                        {formatDate(binding.updatedAt)}
                      </p>
                    </div>
                  ))
                )}
              </TabsContent>

              <div className="mt-5 flex items-center justify-between border-t border-border/50 pt-4">
                <ConfirmDelete
                  title="删除角色目录？"
                  description="会删除角色卡、AGENTS.md、世界书和备注。记忆和表情包默认保留，可在删除后手动清理。"
                  onConfirm={remove}
                />
                <Button variant="outline" size="sm" className="rounded-lg" onClick={onClose}>
                  关闭
                </Button>
              </div>
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ScopeRow({
  scope,
  onOpen,
}: {
  scope: RoleplayMemoryScope;
  onOpen: (kind: "user" | "scene", actorQq: number) => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{scope.label}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{scope.scope}</p>
        </div>
        <Badge variant="outline">{scope.kind === "shared" ? "共享" : "私有"}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {scope.docs.map((doc) => (
          <Button
            key={`${doc.kind}-${doc.actorQq}-${doc.name}`}
            variant="secondary"
            size="sm"
            onClick={() => onOpen(doc.kind, doc.actorQq ?? scope.actorQq ?? 0)}
          >
            {doc.kind === "scene"
              ? "群聊场景"
              : doc.actorQq === null
                ? doc.name
                : `用户 ${doc.actorQq}`}
            <span className="ml-1 text-[10px] text-muted-foreground">
              {Math.round(doc.size / 1024)} KB
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function WorldbookRow({ entry }: { entry: RoleplayWorldbookEntry }) {
  return (
    <details className="group rounded-xl border border-border/60 bg-card/50 p-4 transition-colors open:bg-card/80">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{entry.name}</span>
          {entry.constant && <Badge>常驻</Badge>}
          {entry.selective && <Badge variant="secondary">主+次</Badge>}
          {entry.matchWholeWords === true && <Badge variant="outline">整词</Badge>}
          <span className="text-[11px] text-muted-foreground">
            优先级 {entry.priority} · 顺序 {entry.insertionOrder} · {entry.position}
          </span>
        </div>
      </summary>
      <div className="mt-3 space-y-2.5 border-t border-border/50 pt-3">
        <div className="flex flex-wrap gap-1.5">
          {entry.keys.map((key) => (
            <Badge key={`k-${key}`} variant="outline" className="font-mono text-[10px]">
              {key}
            </Badge>
          ))}
          {entry.secondaryKeys.map((key) => (
            <Badge key={`s-${key}`} variant="secondary" className="font-mono text-[10px]">
              {key}
            </Badge>
          ))}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
          {entry.content}
        </p>
      </div>
    </details>
  );
}

function Preview({ title, value }: { title: string; value: string }) {
  if (value.trim().length === 0) return null;
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{value}</p>
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-3.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`mt-1 break-all text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}
