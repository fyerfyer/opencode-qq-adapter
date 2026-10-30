import { FolderGit2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiQuery } from "@/hooks/use-api-query";

export function ProjectsPage() {
  const { data, error, loading, refresh } = useApiQuery<AccessSnapshot>("/access");
  const [dialog, setDialog] = useState<ProjectRecord | "new" | null>(null);
  const [showHidden, setShowHidden] = useState(false);

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

  const visible = data.projects.filter((project) => !project.hidden);
  const internal = data.projects.filter((project) => project.hidden);
  const projects = showHidden ? data.projects : visible;
  const authorizedUsers = data.users.filter(
    (user) => user.projects.includes("*") || user.projects.some((id) => !isHidden(id, data)),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="项目"
        description="注册可供 QQ 成员使用的项目目录。成员能访问哪些项目、能修改哪些项目在「成员」页配置。"
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
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>已注册项目</CardTitle>
            <CardDescription>
              路径必须在 security.allowed_roots 内，且启动时目录必须存在。
            </CardDescription>
          </div>
          {internal.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showHidden}
                onCheckedChange={setShowHidden}
                aria-label="显示内部项目"
              />
              显示内部项目（{internal.length}）
            </div>
          )}
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <EmptyState
              title="还没有项目"
              description="至少注册一个项目后，QQ 成员才能开始工作。"
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
                  <TableHead>工作区</TableHead>
                  <TableHead>Agent / Model</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{project.id}</span>
                        {project.hidden && <Badge variant="outline">内部</Badge>}
                        {project.managed_by !== undefined && (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {project.managed_by}
                          </Badge>
                        )}
                      </div>
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
                      <Badge variant={project.workspace === "shared" ? "secondary" : "outline"}>
                        {project.workspace}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{project.agent ?? "默认 agent"}</div>
                      <div>{project.model ?? "默认 model"}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => setDialog(project)}>
                          <Settings2 />
                        </Button>
                        <ConfirmDelete
                          title={`删除项目 ${project.id}？`}
                          description="成员配置中对它的引用会阻止保存并返回校验错误。"
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
        <Metric label="可见项目" value={visible.length} />
        <Metric label="内部项目" value={internal.length} />
        <Metric label="被授权成员" value={authorizedUsers.length} />
      </div>

      {dialog !== null && (
        <ProjectDialog
          key={dialog === "new" ? "new" : dialog.id}
          project={dialog === "new" ? undefined : dialog}
          onClose={() => setDialog(null)}
          onSave={(projectId, body) =>
            save(`/projects/${dialog === "new" ? projectId : dialog.id}`, body)
          }
        />
      )}
    </div>
  );
}

function isHidden(id: string, data: AccessSnapshot): boolean {
  return data.projects.find((project) => project.id === id)?.hidden === true;
}

function ProjectDialog({
  project,
  onClose,
  onSave,
}: {
  project?: ProjectRecord;
  onClose: () => void;
  onSave: (id: string, body: Record<string, unknown>) => void;
}) {
  const [id, setId] = useState(project?.id ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [workspace, setWorkspace] = useState<ProjectRecord["workspace"]>(
    project?.workspace ?? "shared",
  );
  const [agent, setAgent] = useState(project?.agent ?? "");
  const [model, setModel] = useState(project?.model ?? "");
  const [hidden, setHidden] = useState(project?.hidden ?? false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{project === undefined ? "添加项目" : `编辑项目 ${project.id}`}</DialogTitle>
          <DialogDescription>
            相对路径会相对配置文件所在目录解析。内部项目不会出现在成员的项目选择中。
          </DialogDescription>
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
                <SelectItem value="none">none（插件内部）</SelectItem>
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
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <p className="text-sm font-medium">内部项目</p>
              <p className="text-xs text-muted-foreground">
                不显示在成员可选项目中，只允许插件内部切换
              </p>
            </div>
            <Switch checked={hidden} onCheckedChange={setHidden} />
          </div>
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
                workspace,
                agent: agent.trim() === "" ? null : agent.trim(),
                model: model.trim() === "" ? null : model.trim(),
                ...(description.trim() !== "" ? { description: description.trim() } : {}),
                hidden,
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
