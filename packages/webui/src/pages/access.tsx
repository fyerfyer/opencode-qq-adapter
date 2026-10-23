import { Plus, RefreshCw, Settings2, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { AccessSnapshot, GroupRecord, UserRecord } from "@/api/types";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/hooks/use-api-query";
import { parseList } from "@/lib/utils";

type DialogState =
  | { kind: "user"; user?: UserRecord }
  | { kind: "group"; group?: GroupRecord }
  | null;

export function AccessPage() {
  const { data, error, loading, refresh } = useApiQuery<AccessSnapshot>("/access");
  const [dialog, setDialog] = useState<DialogState>(null);

  const save = async (path: string, body: unknown) => {
    try {
      await api.put(path, body, data?.configHash ?? undefined);
      toast.success("配置已保存并热加载");
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

  const projectOptions = data.projects.map((project) => project.id);
  const policyOptions = data.policies.map((policy) => policy.name);

  return (
    <div className="space-y-6">
      <PageHeader
        title="用户与群"
        description="控制谁能通过 QQ 使用哪些项目，以及群聊的共享与只读模式。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" onClick={() => setDialog({ kind: "user" })}>
              <Plus /> 添加用户
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

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">用户 {data.users.length}</TabsTrigger>
          <TabsTrigger value="groups">群 {data.groups.length}</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <Card>
            <CardHeader className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>QQ 用户</CardTitle>
                <CardDescription>owner / admin / member 以及项目授权。</CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "user" })}>
                <Plus /> 添加
              </Button>
            </CardHeader>
            <CardContent>
              {data.users.length === 0 ? (
                <EmptyState
                  title="还没有用户"
                  description="未配置的用户会被静默忽略。先添加 owner QQ，再配置项目授权。"
                  icon={<UsersRound />}
                  action={
                    <Button size="sm" onClick={() => setDialog({ kind: "user" })}>
                      <Plus />
                      添加用户
                    </Button>
                  }
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>QQ</TableHead>
                      <TableHead>角色</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>策略</TableHead>
                      <TableHead>限制</TableHead>
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
                          <ProjectTags projects={user.projects} />
                        </TableCell>
                        <TableCell className="text-sm">{user.policy ?? "—"}</TableCell>
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
                              title={`删除用户 ${user.qq}？`}
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
        </TabsContent>

        <TabsContent value="groups" className="mt-4">
          <Card>
            <CardHeader className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>QQ 群</CardTitle>
                <CardDescription>per_user / shared / readonly 三种群模式。</CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "group" })}>
                <Plus /> 添加群
              </Button>
            </CardHeader>
            <CardContent>
              {data.groups.length === 0 ? (
                <EmptyState
                  title="还没有群"
                  description="群必须在 groups 中启用、命中用户 allowlist，并按需 @bot。"
                  action={
                    <Button size="sm" onClick={() => setDialog({ kind: "group" })}>
                      <Plus />
                      添加群
                    </Button>
                  }
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>群号</TableHead>
                      <TableHead>模式</TableHead>
                      <TableHead>启用</TableHead>
                      <TableHead>成员</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.groups.map((group) => (
                      <TableRow key={group.id}>
                        <TableCell className="font-mono text-sm">{group.id}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{group.mode}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={group.enabled ? "default" : "secondary"}>
                            {group.enabled ? "启用" : "停用"}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-44">
                          <ProjectTags projects={group.allowed_users} />
                        </TableCell>
                        <TableCell>
                          <ProjectTags projects={group.projects} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDialog({ kind: "group", group })}
                            >
                              <Settings2 />
                            </Button>
                            <ConfirmDelete
                              title={`删除群 ${group.id}？`}
                              description="删除后该群消息会被拒绝；正在运行的会话不受影响。"
                              onConfirm={() => remove(`/groups/${group.id}`)}
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
        </TabsContent>
      </Tabs>

      {dialog?.kind === "user" && (
        <UserDialog
          key={dialog.user?.qq ?? "new-user"}
          user={dialog.user}
          policyOptions={policyOptions}
          onClose={() => setDialog(null)}
          onSave={(qq, body) => save(`/users/${dialog.user?.qq ?? qq}`, body)}
        />
      )}

      {dialog?.kind === "group" && (
        <GroupDialog
          key={dialog.group?.id ?? "new-group"}
          group={dialog.group}
          projectOptions={projectOptions}
          policyOptions={policyOptions}
          onClose={() => setDialog(null)}
          onSave={(groupId, body) => save(`/groups/${dialog.group?.id ?? groupId}`, body)}
        />
      )}
    </div>
  );
}

function UserDialog({
  user,
  policyOptions,
  onClose,
  onSave,
}: {
  user?: UserRecord;
  policyOptions: string[];
  onClose: () => void;
  onSave: (qq: string, body: Record<string, unknown>) => void;
}) {
  const [qq, setQq] = useState(user?.qq ?? "");
  const [role, setRole] = useState<UserRecord["role"]>(user?.role ?? "member");
  const [projects, setProjects] = useState((user?.projects ?? []).join(", "));
  const [policy, setPolicy] = useState(user?.policy ?? "none");
  const [note, setNote] = useState(user?.note ?? "");
  const [promptsPerMinute, setPromptsPerMinute] = useState(
    user?.limits?.prompts_per_minute?.toString() ?? "",
  );
  const [runsPerHour, setRunsPerHour] = useState(user?.limits?.runs_per_hour?.toString() ?? "");
  const [dailyCost, setDailyCost] = useState(user?.limits?.daily_cost_usd?.toString() ?? "");
  const [dailyTokens, setDailyTokens] = useState(user?.limits?.daily_tokens?.toString() ?? "");

  const submit = () => {
    const limits = compactNumbers({
      prompts_per_minute: promptsPerMinute,
      runs_per_hour: runsPerHour,
      daily_cost_usd: dailyCost,
      daily_tokens: dailyTokens,
    });
    onSave(qq, {
      role,
      projects: parseList(projects),
      ...(policy !== "none" ? { policy } : {}),
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      ...(limits !== undefined ? { limits } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{user === undefined ? "添加用户" : `编辑用户 ${user.qq}`}</DialogTitle>
          <DialogDescription>项目列表支持 `*`；限制只能收紧全局值。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <Field label="QQ 号">
            <Input
              value={qq}
              disabled={user !== undefined}
              placeholder="10001"
              onChange={(event) => setQq(event.target.value)}
            />
          </Field>
          <Field label="角色">
            <Select value={role} onValueChange={(value) => setRole(value as UserRecord["role"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="member">member</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="项目（逗号分隔）" className="sm:col-span-2">
            <Input
              value={projects}
              placeholder="blog, infra 或 *"
              onChange={(event) => setProjects(event.target.value)}
            />
          </Field>
          <Field label="用户级策略">
            <Select value={policy} onValueChange={setPolicy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">继承项目策略</SelectItem>
                {policyOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="备注">
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="可选"
            />
          </Field>
          <div className="sm:col-span-2">
            <p className="mb-2 text-sm font-medium">个人限制</p>
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

function GroupDialog({
  group,
  projectOptions,
  policyOptions,
  onClose,
  onSave,
}: {
  group?: GroupRecord;
  projectOptions: string[];
  policyOptions: string[];
  onClose: () => void;
  onSave: (id: string, body: Record<string, unknown>) => void;
}) {
  const [id, setId] = useState(group?.id ?? "");
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [mode, setMode] = useState<GroupRecord["mode"]>(group?.mode ?? "per_user");
  const [mention, setMention] = useState(
    group?.require_mention === undefined ? "default" : group.require_mention ? "true" : "false",
  );
  const [allowedUsers, setAllowedUsers] = useState((group?.allowed_users ?? []).join(", "));
  const [projects, setProjects] = useState((group?.projects ?? []).join(", "));
  const [defaultProject, setDefaultProject] = useState(group?.default_project ?? "none");
  const [policy, setPolicy] = useState(group?.policy ?? "none");

  const submit = () => {
    onSave(id, {
      enabled,
      mode,
      ...(mention === "default" ? {} : { require_mention: mention === "true" }),
      allowed_users: parseList(allowedUsers),
      projects: parseList(projects),
      ...(defaultProject !== "none" ? { default_project: defaultProject } : {}),
      ...(policy !== "none" ? { policy } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{group === undefined ? "添加群" : `编辑群 ${group.id}`}</DialogTitle>
          <DialogDescription>shared 群的审批只允许 owner/admin。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <Field label="群号">
            <Input
              value={id}
              disabled={group !== undefined}
              placeholder="20001"
              onChange={(event) => setId(event.target.value)}
            />
          </Field>
          <Field label="模式">
            <Select value={mode} onValueChange={(value) => setMode(value as GroupRecord["mode"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_user">per_user</SelectItem>
                <SelectItem value="shared">shared</SelectItem>
                <SelectItem value="readonly">readonly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="允许成员（QQ，逗号分隔）" className="sm:col-span-2">
            <Input
              value={allowedUsers}
              onChange={(event) => setAllowedUsers(event.target.value)}
              placeholder="10001, 10002"
            />
          </Field>
          <Field label="项目（逗号分隔）" className="sm:col-span-2">
            <Input
              value={projects}
              onChange={(event) => setProjects(event.target.value)}
              placeholder="blog 或 *"
            />
          </Field>
          <Field label="默认项目">
            <Select value={defaultProject} onValueChange={setDefaultProject}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不指定</SelectItem>
                {projectOptions.map((project) => (
                  <SelectItem key={project} value={project}>
                    {project}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="群级策略">
            <Select value={policy} onValueChange={setPolicy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">继承项目策略</SelectItem>
                {policyOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="需要 @bot">
            <Select value={mention} onValueChange={setMention}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">跟随全局</SelectItem>
                <SelectItem value="true">必须 @</SelectItem>
                <SelectItem value="false">不需要</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <p className="text-sm font-medium">启用</p>
              <p className="text-xs text-muted-foreground">停用后忽略该群所有消息</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={!/^\d{5,12}$/.test(id)}>
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
      {role}
    </Badge>
  );
}

function ProjectTags({ projects }: { projects: string[] }) {
  if (projects.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {projects.map((project) => (
        <Badge key={project} variant="secondary" className="font-mono text-[11px]">
          {project}
        </Badge>
      ))}
    </div>
  );
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
