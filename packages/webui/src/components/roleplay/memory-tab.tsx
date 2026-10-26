import { History, LoaderCircle, MemoryStick, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type {
  RoleplayMemoryDoc,
  RoleplayMemoryHistoryEntry,
  RoleplayMemoryScope,
  RoleplayPersonaSummary,
} from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "@/lib/utils";
import type { MemoryTarget } from "./personas-tab";
import { DiffPreview, MarkdownEditor, MarkdownPreview } from "./shared";

export function MemoryTab({ initial }: { initial?: MemoryTarget | null }) {
  const personas = useApiQuery<{ personas: RoleplayPersonaSummary[] }>(
    "/plugins/roleplay/personas",
  );
  const [personaId, setPersonaId] = useState(initial?.personaId ?? "");
  const [scope, setScope] = useState(initial?.scope ?? "");
  const [kind, setKind] = useState<"user" | "scene">(initial?.kind ?? "user");
  const [actorQq, setActorQq] = useState(initial?.actorQq ?? 0);
  const [content, setContent] = useState("");
  const [allowManual, setAllowManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<unknown>(null);
  const [historyPreview, setHistoryPreview] = useState<{
    entry: RoleplayMemoryHistoryEntry;
    content: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (personaId.length === 0 && personas.data !== null) {
      setPersonaId(personas.data.personas[0]?.id ?? "");
    }
  }, [personaId, personas.data]);

  useEffect(() => {
    if (initial === undefined || initial === null) return;
    setPersonaId(initial.personaId);
    setScope(initial.scope);
    setKind(initial.kind);
    setActorQq(initial.actorQq);
  }, [initial]);

  const scopes = useApiQuery<{ scopes: RoleplayMemoryScope[] }>(
    personaId.length > 0
      ? `/plugins/roleplay/memory/scopes?persona=${encodeURIComponent(personaId)}`
      : null,
  );

  useEffect(() => {
    if (scope.length > 0 || scopes.data === null) return;
    const first = scopes.data.scopes[0];
    const doc = first?.docs[0];
    if (first !== undefined && doc !== undefined) {
      setScope(first.scope);
      setKind(doc.kind);
      setActorQq(doc.actorQq ?? first.actorQq ?? 0);
    }
  }, [scope, scopes.data]);

  const query =
    personaId.length > 0 && scope.length > 0
      ? `persona=${encodeURIComponent(personaId)}&scope=${encodeURIComponent(scope)}&kind=${kind}&actorQq=${actorQq}`
      : null;
  const document = useApiQuery<{
    document: RoleplayMemoryDoc;
    history: RoleplayMemoryHistoryEntry[];
  }>(query === null ? null : `/plugins/roleplay/memory/document?${query}`);

  useEffect(() => {
    if (document.data !== null) setContent(document.data.document.content);
  }, [document.data]);

  const selectedScope = useMemo(
    () => scopes.data?.scopes.find((item) => item.scope === scope) ?? null,
    [scope, scopes.data],
  );

  const selectDoc = (item: RoleplayMemoryScope, doc: RoleplayMemoryScope["docs"][number]) => {
    setScope(item.scope);
    setKind(doc.kind);
    setActorQq(doc.actorQq ?? item.actorQq ?? 0);
    setSearchResult(null);
    setHistoryPreview(null);
  };

  const save = async () => {
    if (document.data === null) return;
    setSaving(true);
    try {
      const result = await api.put<{ document: RoleplayMemoryDoc }>(
        "/plugins/roleplay/memory/document",
        {
          persona: personaId,
          scope,
          kind,
          actorQq,
          content,
          allowManual,
        },
      );
      toast.success("记忆已保存，旧版本已进入历史");
      setContent(result.document.content);
      await document.refresh(true);
      await scopes.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const search = async () => {
    if (query === null || searchQuery.trim().length === 0) return;
    try {
      const result = await api.get(
        `/plugins/roleplay/memory/search?${query}&q=${encodeURIComponent(searchQuery)}`,
      );
      setSearchResult(result);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const openHistory = async (entry: RoleplayMemoryHistoryEntry) => {
    try {
      const result = await api.get<{ content: string }>(
        `/plugins/roleplay/memory/history/file?path=${encodeURIComponent(entry.path)}`,
      );
      setHistoryPreview({ entry, content: result.content });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const restore = async () => {
    if (historyPreview === null) return;
    try {
      await api.post("/plugins/roleplay/memory/history/restore", {
        path: historyPreview.entry.path,
        persona: personaId,
        scope,
        kind,
        actorQq,
      });
      toast.success("历史版本已恢复");
      setHistoryPreview(null);
      await document.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const refreshMemory = async () => {
    if (scope.length === 0) return;
    setRefreshing(true);
    try {
      const created = await api.post<{ job: { id: string; status: string } }>(
        "/plugins/roleplay/memory/refresh",
        { persona: personaId, scope },
      );
      let job = created.job;
      for (let attempt = 0; attempt < 120 && job.status === "running"; attempt += 1) {
        await delay(1000);
        const next = await api.get<{
          job: typeof job & { result?: unknown; error?: string | null };
        }>(`/plugins/roleplay/memory/jobs/${job.id}`);
        job = next.job;
      }
      if (job.status === "completed") {
        toast.success("记忆整理完成");
        await document.refresh(true);
        await scopes.refresh(true);
      } else {
        toast.error(job.status === "failed" ? "记忆整理失败" : "记忆整理超时");
      }
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRefreshing(false);
    }
  };

  const removeScope = async () => {
    if (query === null) return;
    try {
      await api.delete(`/plugins/roleplay/memory/scope?${query}`);
      toast.success("该 scope 的记忆和原文已删除");
      setScope("");
      await scopes.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  if (personas.loading && personas.data === null) return <LoadingState rows={5} />;
  if (personas.error !== null && personas.data === null)
    return <ErrorState message={personas.error} />;
  if ((personas.data?.personas.length ?? 0) === 0) {
    return (
      <EmptyState
        title="还没有角色"
        description="先在「角色」页导入一张角色卡，记忆会按角色和会话隔离。"
        icon={<MemoryStick />}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">会话与 scope</CardTitle>
          <CardDescription>每个 QQ 会话独立；shared 群有 scene 和成员文档。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select
            value={personaId}
            onValueChange={(value) => {
              setPersonaId(value);
              setScope("");
              setSearchResult(null);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择角色" />
            </SelectTrigger>
            <SelectContent>
              {(personas.data?.personas ?? []).map((persona) => (
                <SelectItem key={persona.id} value={persona.id}>
                  {persona.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {scopes.loading && scopes.data === null && <LoadingState rows={3} />}
          {scopes.error !== null && <ErrorState message={scopes.error} />}
          {scopes.data !== null && scopes.data.scopes.length === 0 && (
            <p className="rounded-lg border border-dashed p-3 text-xs leading-5 text-muted-foreground">
              还没有记忆。先在 QQ 里聊天或使用 !remember，再刷新。
            </p>
          )}
          <div className="space-y-2">
            {(scopes.data?.scopes ?? []).map((item) => (
              <div key={item.scope} className="rounded-lg border p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-medium">{item.label}</p>
                  <Badge variant="outline" className="text-[10px]">
                    {item.kind === "shared" ? "shared" : "private"}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                  {item.scope}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.docs.map((doc) => (
                    <Button
                      key={`${doc.kind}-${doc.actorQq}-${doc.name}`}
                      size="sm"
                      variant={
                        doc.kind === kind && item.scope === scope && doc.actorQq === actorQq
                          ? "default"
                          : "secondary"
                      }
                      className="h-7 text-[11px]"
                      onClick={() => selectDoc(item, doc)}
                    >
                      {doc.kind === "scene"
                        ? "场景"
                        : doc.actorQq === null
                          ? doc.name
                          : `用户 ${doc.actorQq}`}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-4">
        {scope.length === 0 ? (
          <EmptyState
            title="选择一个记忆文档"
            description="左侧按角色和 QQ 会话列出 memory.md、scene.md 和群成员文档。"
            icon={<MemoryStick />}
          />
        ) : (
          <>
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {selectedScope?.label ?? scope} ·{" "}
                    {kind === "scene" ? "群聊场景" : actorQq > 0 ? `用户 ${actorQq}` : "用户记忆"}
                  </CardTitle>
                  <CardDescription>{document.data?.document.path ?? "加载中…"}</CardDescription>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => void document.refresh(true)}>
                    <RefreshCw /> 刷新
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshing}
                    onClick={() => void refreshMemory()}
                  >
                    {refreshing ? <LoaderCircle className="animate-spin" /> : <History />} 整理
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      saving || document.data === null || content === document.data.document.content
                    }
                    onClick={() => void save()}
                  >
                    {saving ? <LoaderCircle className="animate-spin" /> : <Save />} 保存
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {document.loading && document.data === null && <LoadingState rows={5} />}
                {document.error !== null && <ErrorState message={document.error} />}
                {document.data !== null && (
                  <>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <Badge variant="outline">{kind}</Badge>
                      <span>更新 {formatDate(document.data.document.updatedAt)}</span>
                      <span>{document.data.document.exists ? "已存在" : "尚未创建"}</span>
                      {document.data.history.length > 0 && (
                        <span>{document.data.history.length} 个历史版本</span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        <Switch checked={allowManual} onCheckedChange={setAllowManual} />
                        <span>允许修改「手动记忆」</span>
                      </div>
                    </div>
                    <Tabs defaultValue="edit">
                      <TabsList>
                        <TabsTrigger value="edit">编辑</TabsTrigger>
                        <TabsTrigger value="preview">预览</TabsTrigger>
                        <TabsTrigger value="history">历史</TabsTrigger>
                        <TabsTrigger value="search">原文搜索</TabsTrigger>
                      </TabsList>
                      <TabsContent value="edit" className="mt-3">
                        <MarkdownEditor value={content} onChange={setContent} minHeight="24rem" />
                      </TabsContent>
                      <TabsContent value="preview" className="mt-3">
                        <div className="max-h-[32rem] overflow-auto rounded-lg border p-4">
                          <MarkdownPreview content={content} />
                        </div>
                      </TabsContent>
                      <TabsContent value="history" className="mt-3 space-y-2">
                        {document.data.history.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            还没有历史版本。再次保存后会生成快照。
                          </p>
                        ) : (
                          document.data.history.map((entry) => (
                            <div
                              key={entry.path}
                              className="flex items-center justify-between gap-2 rounded-lg border p-2"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-mono text-xs">{entry.name}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {formatDate(entry.createdAt)}
                                </p>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void openHistory(entry)}
                              >
                                查看 diff
                              </Button>
                            </div>
                          ))
                        )}
                      </TabsContent>
                      <TabsContent value="search" className="mt-3 space-y-2">
                        <div className="flex gap-2">
                          <Input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="搜索 Markdown 记忆和原文 FTS"
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void search();
                            }}
                          />
                          <Button variant="outline" size="sm" onClick={() => void search()}>
                            <Search /> 搜索
                          </Button>
                        </div>
                        {searchResult !== null && (
                          <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs leading-5 whitespace-pre-wrap">
                            {JSON.stringify(searchResult, null, 2)}
                          </pre>
                        )}
                      </TabsContent>
                    </Tabs>
                  </>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <ConfirmDelete
                title="删除这个 scope 的记忆？"
                description="会删除 Markdown 文档、历史快照、原文消息和记忆事件。此操作不可撤销。"
                onConfirm={removeScope}
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 /> 删除整个 scope
                  </Button>
                }
              />
            </div>
          </>
        )}
      </div>

      <Dialog
        open={historyPreview !== null}
        onOpenChange={(open) => !open && setHistoryPreview(null)}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>历史版本 diff</DialogTitle>
            <DialogDescription>
              {historyPreview?.entry.name} · {formatDate(historyPreview?.entry.createdAt)}
            </DialogDescription>
          </DialogHeader>
          {historyPreview !== null && (
            <DiffPreview before={historyPreview.content} after={content} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryPreview(null)}>
              关闭
            </Button>
            <Button onClick={() => void restore()}>恢复这个版本</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
