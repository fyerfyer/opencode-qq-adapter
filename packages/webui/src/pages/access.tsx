import { Info, Plus, RefreshCw, Settings2, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { AccessSnapshot, ProjectRecord, UserRecord } from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/data-state";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";

type DialogState = { kind: "user"; user?: UserRecord } | null;

const ROLE_LABELS: Record<UserRecord["role"], string> = {
  owner: "所有者",
  admin: "管理员",
  member: "使用者",
};

const ROLE_HINTS: Record<UserRecord["role"], string> = {
  owner: "所有管理权限，并可执行 !sudo、!ws clean 等危险操作。",
  admin: "可以修改 Bot 配置、热加载、管理插件和查看审计；项目写入仍受项目权限限制。",
  member: "只能对话、切换可用项目和使用 Roleplay；不能修改 Bot 配置。",
};

export function AccessPage() {
  const { data, error, loading, refresh } = useApiQuery<AccessSnapshot>("/access");
  const [dialog, setDialog] = useState<DialogState>(null);

  const save = async (path: string, body: unknown) => {
    try {
      await api.put(path, body, data?.configHash ?? undefined);
      toast.success("成员配置已保存并热加载");
      setDialog(null);
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const remove = async (path: string) => {
    try {
      await api.delete(path, data?.configHash ?? undefined);
      toast.success("已删除");
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

  const visibleProjects = data.projects.filter((project) => !project.hidden);

  return (
    <div className="space-y-6">
      <PageHeader
        title="成员"
        description="每个 QQ 只有一套权限：私聊和群聊都按这里配置执行。未列出的用户会被静默忽略。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" onClick={() => setDialog({ kind: "user" })}>
              <Plus /> 添加成员
            </Button>
          </>
        }
      />

      {data.warnings.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="space-y-1 p-4 text-sm text-amber-700 dark:text-amber-300">
            {data.warnings.map((warning) => (
              <p key={warning}>• {warning}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-sky-500/20 bg-sky-500/5">
        <CardContent className="flex gap-3 p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <p className="text-muted-foreground">
            群聊不需要额外配置：任何已添加的成员都可以在群里使用 Bot，默认每人独立会话；未添加的 QQ
            即使在群里 @ Bot 也不会响应。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>QQ 成员</CardTitle>
          </div>
          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "user" })}>
            <Plus /> 添加
          </Button>
        </CardHeader>
        <CardContent>
          {data.users.length === 0 ? (
            <EmptyState
              title="还没有成员"
              description="先添加你自己的 QQ，并至少授权一个项目。"
              icon={<UsersRound />}
              action={
                <Button size="sm" onClick={() => setDialog({ kind: "user" })}>
                  <Plus />
                  添加成员
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>QQ</TableHead>
                  <TableHead>身份</TableHead>
                  <TableHead>可访问项目</TableHead>
                  <TableHead>可修改项目</TableHead>
                  <TableHead>限额</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.users.map((user) => (
                  <TableRow key={user.qq}>
                    <TableCell>
                      <div className="font-mono text-sm">{user.qq}</div>
                      {user.note !== undefined && (
                        <div className="text-xs text-muted-foreground">{user.note}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell>
                      <ProjectTags projects={user.projects} all={visibleProjects} />
                    </TableCell>
                    <TableCell>
                      <ProjectTags projects={user.write_projects} all={visibleProjects} writable />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatLimits(user.limits)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDialog({ kind: "user", user })}
                        >
                          <Settings2 />
                        </Button>
                        <ConfirmDelete
                          title={`删除成员 ${user.qq}？`}
                          description="这不会立即中断正在运行的会话，但新请求会被拒绝。保存后配置会热加载。"
                          onConfirm={() => remove(`/users/${user.qq}`)}
                          trigger={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 />
                            </Button>
                          }
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "user" && (
        <UserDialog
          key={dialog.user?.qq ?? "new-user"}
          user={dialog.user}
          projects={visibleProjects}
          onClose={() => setDialog(null)}
          onSave={(qq, body) => save(`/users/${dialog.user?.qq ?? qq}`, body)}
        />
      )}
    </div>
  );
}

function UserDialog({
  user,
  projects,
  onClose,
  onSave,
}: {
  user?: UserRecord;
  projects: ProjectRecord[];
  onClose: () => void;
  onSave: (qq: string, body: Record<string, unknown>) => void;
}) {
  const [qq, setQq] = useState(user?.qq ?? "");
  const [role, setRole] = useState<UserRecord["role"]>(user?.role ?? "member");

  const allProjectIds = projects.map((project) => project.id);
  const initialAccess = expandProjectList(user?.projects ?? [], allProjectIds);
  const initialWrite = expandProjectList(user?.write_projects ?? [], allProjectIds);
  const [access, setAccess] = useState<Set<string>>(new Set(initialAccess));
  const [write, setWrite] = useState<Set<string>>(new Set(initialWrite));
  const [note, setNote] = useState(user?.note ?? "");
  const [promptsPerMinute, setPromptsPerMinute] = useState(
    user?.limits?.prompts_per_minute?.toString() ?? "",
  );
  const [runsPerHour, setRunsPerHour] = useState(user?.limits?.runs_per_hour?.toString() ?? "");
  const [dailyCost, setDailyCost] = useState(user?.limits?.daily_cost_usd?.toString() ?? "");
  const [dailyTokens, setDailyTokens] = useState(user?.limits?.daily_tokens?.toString() ?? "");

  const toggleAccess = (id: string, checked: boolean) => {
    setAccess((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!checked) {
      setWrite((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleWrite = (id: string, checked: boolean) => {
    setWrite((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    if (checked) {
      setAccess((current) => new Set(current).add(id));
    }
  };

  const submit = () => {
    const limits = compactNumbers({
      prompts_per_minute: promptsPerMinute,
      runs_per_hour: runsPerHour,
      daily_cost_usd: dailyCost,
      daily_tokens: dailyTokens,
    });
    const accessIds = allProjectIds.filter((id) => access.has(id));
    const writeIds = allProjectIds.filter((id) => write.has(id) && access.has(id));
    onSave(qq, {
      role,
      projects:
        allProjectIds.length > 0 && accessIds.length === allProjectIds.length ? ["*"] : accessIds,
      write_projects:
        allProjectIds.length > 0 && writeIds.length === allProjectIds.length ? ["*"] : writeIds,
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      ...(limits !== undefined ? { limits } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{user === undefined ? "添加成员" : `编辑成员 ${user.qq}`}</DialogTitle>
          <DialogDescription>
            私聊和群聊使用同一套权限。可修改项目自动包含可访问权限。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="QQ 号">
              <Input
                value={qq}
                disabled={user !== undefined}
                placeholder="10001"
                onChange={(event) => setQq(event.target.value)}
              />
            </Field>
            <Field label="身份">
              <Select value={role} onValueChange={(value) => setRole(value as UserRecord["role"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">使用者</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                  <SelectItem value="owner">所有者</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <p className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {ROLE_HINTS[role]}
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">项目权限</p>
              <p className="text-xs text-muted-foreground">
                未勾选“可修改”的项目只能问答，写入会直接被拒绝。
              </p>
            </div>
            {projects.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                还没有可见项目，请先到“项目”页添加。
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <div className="grid grid-cols-[1fr_80px_80px] gap-2 border-b bg-muted/30 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  <span>项目</span>
                  <span className="text-center">可访问</span>
                  <span className="text-center">可修改</span>
                </div>
                {projects.map((project) => (
                  <div
                    key={project.id}
                    className="grid grid-cols-[1fr_80px_80px] items-center gap-2 border-b px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{project.id}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {project.path}
                      </p>
                    </div>
                    <div className="flex justify-center">
                      <Checkbox
                        checked={access.has(project.id)}
                        aria-label={`允许访问 ${project.id}`}
                        onCheckedChange={(checked) => toggleAccess(project.id, checked === true)}
                      />
                    </div>
                    <div className="flex justify-center">
                      <Checkbox
                        checked={write.has(project.id)}
                        aria-label={`允许修改 ${project.id}`}
                        onCheckedChange={(checked) => toggleWrite(project.id, checked === true)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Field label="备注">
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="可选"
            />
          </Field>

          <div>
            <p className="mb-2 text-sm font-medium">个人限制（只能收紧全局值）</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="每分钟 prompts">
                <Input
                  inputMode="numeric"
                  value={promptsPerMinute}
                  onChange={(event) => setPromptsPerMinute(event.target.value)}
                />
              </Field>
              <Field label="每小时 runs">
                <Input
                  inputMode="numeric"
                  value={runsPerHour}
                  onChange={(event) => setRunsPerHour(event.target.value)}
                />
              </Field>
              <Field label="每日 cost USD">
                <Input
                  inputMode="decimal"
                  value={dailyCost}
                  onChange={(event) => setDailyCost(event.target.value)}
                />
              </Field>
              <Field label="每日 tokens">
                <Input
                  inputMode="numeric"
                  value={dailyTokens}
                  onChange={(event) => setDailyTokens(event.target.value)}
                />
              </Field>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={!/^\d{5,12}$/.test(qq)}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-2 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function RoleBadge({ role }: { role: UserRecord["role"] }) {
  const styles = {
    owner: "border-foreground/20 bg-foreground text-background",
    admin: "border-foreground/20 bg-foreground/5 text-foreground",
    member: "border-border bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={styles[role]}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}

function ProjectTags({
  projects,
  all,
  writable = false,
}: {
  projects: string[];
  all: ProjectRecord[];
  writable?: boolean;
}) {
  const expanded = expandProjectList(
    projects,
    all.map((project) => project.id),
  );
  if (expanded.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">{writable ? "无（只能问答）" : "—"}</span>
    );
  }
  const wildcard = projects.includes("*");
  return (
    <div className="flex flex-wrap gap-1">
      {wildcard && <Badge variant="secondary">全部项目</Badge>}
      {!wildcard &&
        expanded.map((project) => (
          <Badge
            key={project}
            variant={writable ? "default" : "secondary"}
            className="font-mono text-[11px]"
          >
            {project}
          </Badge>
        ))}
    </div>
  );
}

function expandProjectList(projects: string[], all: string[]): string[] {
  return projects.includes("*") ? [...all] : projects.filter((project) => all.includes(project));
}

function formatLimits(limits: UserRecord["limits"]): string {
  if (limits === undefined) return "继承全局";
  const parts: string[] = [];
  if (limits.prompts_per_minute !== undefined) parts.push(`${limits.prompts_per_minute}/min`);
  if (limits.runs_per_hour !== undefined) parts.push(`${limits.runs_per_hour}/h`);
  if (limits.daily_cost_usd !== undefined) parts.push(`$${limits.daily_cost_usd}/d`);
  if (limits.daily_tokens !== undefined) parts.push(`${limits.daily_tokens} tok/d`);
  return parts.length === 0 ? "继承全局" : parts.join(" · ");
}

function compactNumbers(values: Record<string, string>): Record<string, number> | undefined {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.trim() === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) result[key] = parsed;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}
