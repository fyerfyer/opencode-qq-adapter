import {
  ExternalLink,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type {
  AgentModelRecord,
  AgentSession,
  AgentSummaryRecord,
  ConversationRecord,
} from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatCurrency, formatDate, shortId } from "@/lib/utils";
import { RunBadge } from "@/pages/dashboard";

export function SessionsPage() {
  const { data, error, loading, refresh } = useApiQuery<{ conversations: ConversationRecord[] }>(
    "/conversations",
    { intervalMs: 20_000 },
  );
  const [searchParams] = useSearchParams();
  const filter = searchParams.get("project") ?? "";
  const [filterText, setFilterText] = useState(filter);
  const [selected, setSelected] = useState<ConversationRecord | null>(null);
  const [preferences, setPreferences] = useState<ConversationRecord | null>(null);

  const act = async (path: string, body?: unknown, success = "操作成功") => {
    try {
      await api.post(path, body);
      toast.success(success);
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  if (loading && data === null) return <LoadingState rows={6} />;
  if (error !== null && data === null) {
    return (
      <ErrorState
        message={error}
        action={
          <Button size="sm" onClick={() => void refresh()}>
            <RefreshCw />
            重试
          </Button>
        }
      />
    );
  }
  if (data === null) return null;

  const conversations = data.conversations.filter((conversation) => {
    if (filter === "") return true;
    const target = filterText.trim().toLowerCase();
    return (
      conversation.projectId.toLowerCase().includes(target) ||
      conversation.chatKey.toLowerCase().includes(target)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="会话"
        description="QQ chat ↔ OpenCode session 的绑定、运行状态和项目会话列表。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw /> 刷新
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="按项目或 chatKey 过滤"
          className="max-w-sm"
        />
        <Badge variant="secondary">{conversations.length} 个会话</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>会话绑定</CardTitle>
          <CardDescription>
            每行右侧的「模型」按钮可切换该 QQ 会话的 OpenCode Agent / 模型。解绑后下一条 QQ
            消息会创建新 session，旧 session 不会被删除。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {conversations.length === 0 ? (
            <EmptyState
              title="还没有会话"
              description="用户先在 QQ 里发送 !use <project> 或直接对话，这里就会出现绑定记录。"
              icon={<MessagesSquare />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chat</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最近活跃</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversations.map((conversation) => (
                  <TableRow key={conversation.chatKey}>
                    <TableCell>
                      <div className="font-mono text-xs">{conversation.chatKey}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {conversation.actorQq === null ? "system" : `QQ ${conversation.actorQq}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{conversation.projectId}</Badge>
                    </TableCell>
                    <TableCell>
                      {conversation.sessionId === null ? (
                        <span className="text-xs text-muted-foreground">下一条消息创建</span>
                      ) : (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {shortId(conversation.sessionId, 16)}
                        </code>
                      )}
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {conversation.agent ?? "默认 agent"} · {conversation.model ?? "默认 model"}
                      </div>
                    </TableCell>
                    <TableCell>
                      {conversation.activeRun !== null ? (
                        <div className="space-y-1">
                          <RunBadge status={conversation.activeRun.status} />
                          <div className="text-[11px] text-muted-foreground">
                            {shortId(conversation.activeRun.id, 12)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">空闲</span>
                      )}
                      {conversation.pendingApprovals > 0 && (
                        <Badge
                          variant="outline"
                          className="mt-1 border-amber-500/30 text-amber-600 dark:text-amber-400"
                        >
                          {conversation.pendingApprovals} 待审批
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(conversation.lastActiveAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {conversation.activeRun !== null && (
                          <ConfirmDelete
                            title="中断当前 run？"
                            description="会调用 OpenCode interrupt，并清空该会话的排队任务。"
                            confirmLabel="中断"
                            onConfirm={() =>
                              act(
                                `/conversations/${encodeURIComponent(conversation.chatKey)}/stop`,
                                undefined,
                                "已请求中断",
                              )
                            }
                            trigger={
                              <Button variant="ghost" size="icon-sm" title="中断">
                                <Square />
                              </Button>
                            }
                          />
                        )}
                        <ConfirmDelete
                          title="解除会话绑定？"
                          description="不会删除 OpenCode session；下一条 QQ 消息会创建新的 session。"
                          confirmLabel="解绑"
                          onConfirm={() =>
                            act(
                              `/conversations/${encodeURIComponent(conversation.chatKey)}/unbind`,
                              undefined,
                              "已解绑",
                            )
                          }
                          trigger={
                            <Button variant="ghost" size="icon-sm" title="解绑">
                              <RotateCcw />
                            </Button>
                          }
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          title="切换 Agent / 模型"
                          aria-label="切换 Agent / 模型"
                          className="whitespace-nowrap"
                          onClick={() => setPreferences(conversation)}
                        >
                          <Settings2 /> 模型
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="查看项目会话"
                          onClick={() => setSelected(conversation)}
                        >
                          <ExternalLink />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selected !== null && (
        <SessionSheet
          conversation={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void refresh(true)}
        />
      )}

      {preferences !== null && (
        <PreferencesDialog
          conversation={preferences}
          onClose={() => setPreferences(null)}
          onChanged={() => void refresh(true)}
        />
      )}
    </div>
  );
}

function PreferencesDialog({
  conversation,
  onClose,
  onChanged,
}: {
  conversation: ConversationRecord;
  onClose: () => void;
  onChanged: () => void;
}) {
  const projectQuery = encodeURIComponent(conversation.projectId);
  const models = useApiQuery<{ models: AgentModelRecord[] }>(`/models?projectId=${projectQuery}`);
  const agents = useApiQuery<{ agents: AgentSummaryRecord[] }>(`/agents?projectId=${projectQuery}`);
  const [model, setModel] = useState(conversation.model ?? "");
  const [agent, setAgent] = useState(conversation.agent ?? "");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const visibleModels = (models.data?.models ?? [])
    .filter((item) => item.enabled)
    .filter((item) => {
      const target = query.trim().toLowerCase();
      if (target.length === 0) return true;
      return (
        item.id.toLowerCase().includes(target) ||
        item.name.toLowerCase().includes(target) ||
        item.providerID.toLowerCase().includes(target)
      );
    });
  const primaryAgents = (agents.data?.agents ?? []).filter(
    (item) => !item.hidden && item.mode !== "subagent",
  );

  const save = async () => {
    if (model.length === 0 && agent.length === 0) {
      toast.error("请至少选择一个模型或 Agent。");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/conversations/${encodeURIComponent(conversation.chatKey)}/preferences`, {
        ...(model.length > 0 ? { model } : {}),
        ...(agent.length > 0 ? { agent } : {}),
      });
      toast.success("已切换当前会话的 Agent / 模型");
      onChanged();
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>切换 Agent / 模型</DialogTitle>
          <DialogDescription>
            {conversation.chatKey} · 当前 {conversation.agent ?? "默认 agent"} /{" "}
            {conversation.model ?? "默认 model"}。切换会同时更新 OpenCode session。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Agent</p>
            <Select
              value={agent.length > 0 ? agent : "__keep"}
              onValueChange={(value) => setAgent(value === "__keep" ? "" : value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="保持当前 Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__keep">保持当前（{conversation.agent ?? "默认"}）</SelectItem>
                {primaryAgents.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {item.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agents.error !== null && (
              <p className="text-[11px] text-destructive">{agents.error}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">Model</p>
              <span className="text-[11px] text-muted-foreground">
                当前：{conversation.model ?? "默认"}
              </span>
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 provider / model"
            />
            {models.loading && models.data === null && <LoadingState rows={3} />}
            {models.error !== null && <ErrorState message={models.error} />}
            {models.data !== null && (
              <ScrollArea className="h-64 rounded-lg border">
                <div className="space-y-1 p-2">
                  {visibleModels.length === 0 && (
                    <p className="p-4 text-center text-xs text-muted-foreground">没有匹配模型。</p>
                  )}
                  {visibleModels.map((item) => {
                    const active = item.id === model;
                    const vision = item.capabilities?.input.includes("image") ?? false;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setModel(item.id)}
                        className={`flex w-full flex-col gap-1 rounded-lg border p-2 text-left transition-colors ${
                          active
                            ? "border-foreground/40 bg-muted/60"
                            : "border-transparent hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{item.name}</span>
                          {vision && <Badge variant="secondary">vision</Badge>}
                          {item.capabilities?.tools === true && (
                            <Badge variant="outline">tools</Badge>
                          )}
                          {active && <Badge>当前选择</Badge>}
                        </div>
                        <span className="break-all font-mono text-[10px] text-muted-foreground">
                          {item.id}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
            {model.length > 0 && !visibleModels.some((item) => item.id === model) && (
              <p className="text-[11px] text-muted-foreground">
                当前选择 {model} 不在搜索结果中，保存仍会使用它。
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            保存并切换
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionSheet({
  conversation,
  onClose,
  onChanged,
}: {
  conversation: ConversationRecord;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, error, loading, refresh } = useApiQuery<{ sessions: AgentSession[] }>(
    `/projects/${conversation.projectId}/sessions`,
  );

  const switchTo = async (sessionId: string) => {
    try {
      await api.post(`/conversations/${encodeURIComponent(conversation.chatKey)}/switch`, {
        sessionId,
      });
      toast.success("已切换会话");
      onChanged();
      onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const remove = async (sessionId: string) => {
    try {
      await api.delete(`/projects/${conversation.projectId}/sessions/${sessionId}`);
      toast.success("OpenCode 会话已删除");
      await refresh(true);
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>项目会话</SheetTitle>
          <SheetDescription>
            {conversation.projectId} · {conversation.chatKey}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {loading && data === null && <LoadingState rows={4} />}
          {error !== null && (
            <ErrorState
              message={error}
              action={
                <Button size="sm" onClick={() => void refresh()}>
                  重试
                </Button>
              }
            />
          )}
          {data !== null && data.sessions.length === 0 && (
            <EmptyState
              title="没有可见会话"
              description="OpenCode 可能未连接，或该项目还没有 session。"
              icon={<MessagesSquare />}
            />
          )}
          {data !== null && data.sessions.length > 0 && (
            <ScrollArea className="h-[calc(100vh-10rem)] pr-3">
              <div className="space-y-2">
                {data.sessions.map((session) => {
                  const current = session.id === conversation.sessionId;
                  return (
                    <div key={session.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {session.title ?? "(untitled)"}
                          </p>
                          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                            {session.id}
                          </p>
                        </div>
                        {current && <Badge>当前</Badge>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{session.agent ?? "默认 agent"}</span>
                        <span>{session.model ?? "默认 model"}</span>
                        <span>{formatCurrency(session.cost)}</span>
                        <span>更新 {formatDate(session.updated)}</span>
                      </div>
                      <div className="mt-3 flex justify-end gap-1">
                        {!current && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void switchTo(session.id)}
                          >
                            切换
                          </Button>
                        )}
                        <ConfirmDelete
                          title="删除 OpenCode 会话？"
                          description="会话内容会被永久删除；绑定到它的 QQ 会话会被自动解绑。"
                          onConfirm={() => remove(session.id)}
                          trigger={
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 />
                            </Button>
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
