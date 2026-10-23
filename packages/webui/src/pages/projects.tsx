import { FolderGit2, MessagesSquare, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { AccessSnapshot, ProjectRecord } from "@/api/types";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useApiQuery } from "@/hooks/use-api-query";
import { parseList } from "@/lib/utils";

export function ProjectsPage() {
  const { data, error, loading, refresh } = useApiQuery<AccessSnapshot>("/access");
  const [dialog, setDialog] = useState<ProjectRecord | "new" | null>(null);

  const save = async (path: string, body: unknown) => {
    try {
      await api.put(path, body, data?.configHash ?? undefined);
      toast.success("项目配置已保存");
      setDialog(null);
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.delete(`/projects/${id}`, data?.configHash ?? undefined);
      toast.success("项目已删除");
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="项目"
        description="项目路径、默认策略、工作区模式和默认 agent/model。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" onClick={() => setDialog("new")}>
              <Plus /> 添加项目
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>已注册项目</CardTitle>
          <CardDescription>
            路径必须在 security.allowed_roots 内，且启动时目录必须存在。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.projects.length === 0 ? (
            <EmptyState
              title="还没有项目"
              description="至少注册一个项目后，QQ 用户才能通过 !use <project> 开始工作。"
              icon={<FolderGit2 />}
              action={
                <Button size="sm" onClick={() => setDialog("new")}>
                  <Plus />
                  添加项目
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>路径</TableHead>
                  <TableHead>策略</TableHead>
                  <TableHead>工作区</TableHead>
                  <TableHead>Agent / Model</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <div className="font-medium">{project.id}</div>
                      {project.description !== undefined && (
                        <div className="max-w-48 truncate text-xs text-muted-foreground">
                          {project.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-72">
                      <code
                        className="block truncate rounded bg-muted px-1.5 py-0.5 text-xs"
                        title={project.path}
                      >
                        {project.path}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{project.policy}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={project.workspace === "shared" ? "secondary" : "outline"}>
                        {project.workspace}
                      </Badge>
                      {project.workspace !== "shared" && (
                        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                          当前实现会回退到 shared
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{project.agent ?? "默认 agent"}</div>
                      <div>{project.model ?? "默认 model"}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button asChild variant="ghost" size="icon-sm" title="查看会话">
                          <Link to={`/sessions?project=${encodeURIComponent(project.id)}`}>
                            <MessagesSquare />
                          </Link>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDialog(project)}>
                          <Settings2 />
                        </Button>
                        <ConfirmDelete
                          title={`删除项目 ${project.id}？`}
                          description="用户/群配置中对它的引用会阻止保存并返回校验错误。"
                          onConfirm={() => remove(project.id)}
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

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="项目数" value={data.projects.length} />
        <Metric
          label="引用策略"
          value={new Set(data.projects.map((project) => project.policy)).size}
        />
        <Metric
          label="非 shared 模式"
          value={data.projects.filter((project) => project.workspace !== "shared").length}
        />
      </div>

      {dialog !== null && (
        <ProjectDialog
          key={dialog === "new" ? "new" : dialog.id}
          project={dialog === "new" ? undefined : dialog}
          policyOptions={data.policies.map((policy) => policy.name)}
          onClose={() => setDialog(null)}
          onSave={(projectId, body) =>
            save(`/projects/${dialog === "new" ? projectId : dialog.id}`, body)
          }
        />
      )}
    </div>
  );
}

function ProjectDialog({
  project,
  policyOptions,
  onClose,
  onSave,
}: {
  project?: ProjectRecord;
  policyOptions: string[];
  onClose: () => void;
  onSave: (id: string, body: Record<string, unknown>) => void;
}) {
  const [id, setId] = useState(project?.id ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [policy, setPolicy] = useState(project?.policy ?? policyOptions[0] ?? "standard");
  const [workspace, setWorkspace] = useState<ProjectRecord["workspace"]>(
    project?.workspace ?? "shared",
  );
  const [agent, setAgent] = useState(project?.agent ?? "");
  const [model, setModel] = useState(project?.model ?? "");
  const [allowedUsers, setAllowedUsers] = useState((project?.allowed_users ?? []).join(", "));
  const [allowedGroups, setAllowedGroups] = useState((project?.allowed_groups ?? []).join(", "));
  const [baseBranch, setBaseBranch] = useState(project?.base_branch ?? "");
  const [setup, setSetup] = useState((project?.setup ?? []).join("\n"));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{project === undefined ? "添加项目" : `编辑项目 ${project.id}`}</DialogTitle>
          <DialogDescription>相对路径会相对配置文件所在目录解析。</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[70vh] gap-4 overflow-y-auto py-2 sm:grid-cols-2">
          <Field label="项目 ID">
            <Input
              value={id}
              disabled={project !== undefined}
              placeholder="blog"
              onChange={(event) => setId(event.target.value)}
            />
          </Field>
          <Field label="策略">
            <Select value={policy} onValueChange={setPolicy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {policyOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="项目路径" className="sm:col-span-2">
            <Input
              value={path}
              placeholder="/home/me/code/blog 或 ../blog"
              onChange={(event) => setPath(event.target.value)}
            />
          </Field>
          <Field label="描述" className="sm:col-span-2">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="可选"
            />
          </Field>
          <Field label="工作区模式">
            <Select
              value={workspace}
              onValueChange={(value) => setWorkspace(value as ProjectRecord["workspace"])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shared">shared</SelectItem>
                <SelectItem value="per_user">per_user（暂未实现）</SelectItem>
                <SelectItem value="worktree">worktree（暂未实现）</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Base branch">
            <Input
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
              placeholder="可选，例如 main"
            />
          </Field>
          <Field label="默认 agent">
            <Input
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              placeholder="qq-code 或留空"
            />
          </Field>
          <Field label="默认 model">
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="provider/model"
            />
          </Field>
          <Field label="允许用户（QQ，逗号分隔）">
            <Input
              value={allowedUsers}
              onChange={(event) => setAllowedUsers(event.target.value)}
              placeholder="10001"
            />
          </Field>
          <Field label="允许群（群号，逗号分隔）">
            <Input
              value={allowedGroups}
              onChange={(event) => setAllowedGroups(event.target.value)}
              placeholder="20001"
            />
          </Field>
          <Field label="Setup hooks（每行一条）" className="sm:col-span-2">
            <Textarea
              rows={3}
              value={setup}
              onChange={(event) => setSetup(event.target.value)}
              placeholder="pnpm install"
              className="font-mono text-xs"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={id.trim().length === 0 || path.trim().length === 0}
            onClick={() =>
              onSave(id.trim(), {
                path: path.trim(),
                policy,
                workspace,
                agent: agent.trim() === "" ? null : agent.trim(),
                model: model.trim() === "" ? null : model.trim(),
                ...(description.trim() !== "" ? { description: description.trim() } : {}),
                ...(allowedUsers.trim() !== "" ? { allowed_users: parseList(allowedUsers) } : {}),
                ...(allowedGroups.trim() !== ""
                  ? { allowed_groups: parseList(allowedGroups) }
                  : {}),
                ...(baseBranch.trim() !== "" ? { base_branch: baseBranch.trim() } : {}),
                setup: setup
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          >
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
