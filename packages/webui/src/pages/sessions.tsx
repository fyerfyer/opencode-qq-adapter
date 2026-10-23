import { ExternalLink, MessagesSquare, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { AgentSession, ConversationRecord } from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
            解绑后下一条 QQ 消息会创建新 session，旧 session 不会被删除。
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
    </div>
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
