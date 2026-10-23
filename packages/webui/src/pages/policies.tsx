import { Plus, RefreshCw, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { AccessSnapshot, PermissionEffect, PolicyRecord, ShellRule } from "@/api/types";
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
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";

const ACTIONS = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "shell",
  "webfetch",
  "websearch",
  "external_directory",
] as const;

type ActionKey = (typeof ACTIONS)[number];

const ACTION_LABELS: Record<ActionKey, string> = {
  read: "READ",
  glob: "GLOB",
  grep: "GREP",
  edit: "EDIT",
  write: "WRITE",
  shell: "SHELL",
  webfetch: "WEBFETCH",
  websearch: "WEBSEARCH",
  external_directory: "EXT. DIR",
};

export function PoliciesPage() {
  const { data, error, loading, refresh } = useApiQuery<AccessSnapshot>("/access");
  const [dialog, setDialog] = useState<PolicyRecord | "new" | null>(null);

  const save = async (path: string, body: unknown) => {
    try {
      await api.put(path, body, data?.configHash ?? undefined);
      toast.success("策略已保存");
      setDialog(null);
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const remove = async (name: string) => {
    try {
      await api.delete(`/policies/${name}`, data?.configHash ?? undefined);
      toast.success("策略已删除");
      await refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  if (loading && data === null) return <LoadingState rows={5} />;
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
        title="策略"
        description="策略会被编译成 OpenCode 权限规则，并与用户/群/项目策略取最严格值。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" onClick={() => setDialog("new")}>
              <Plus /> 新增策略
            </Button>
          </>
        }
      />

      {data.policies.length === 0 ? (
        <EmptyState
          title="还没有策略"
          description="至少创建一个 standard 策略，项目默认会引用它。"
          icon={<ShieldCheck />}
          action={
            <Button size="sm" onClick={() => setDialog("new")}>
              <Plus />
              新增策略
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.policies.map((policy) => (
            <Card key={policy.name}>
              <CardHeader className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {policy.name}
                    <Badge variant="outline">{policy.shell_rules.length} shell 规则</Badge>
                  </CardTitle>
                  <CardDescription>效果：deny &gt; ask &gt; allow</CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => setDialog(policy)}>
                    <Settings2 />
                  </Button>
                  <ConfirmDelete
                    title={`删除策略 ${policy.name}？`}
                    description="如果仍有用户、群或项目引用它，保存会被校验拦截。"
                    onConfirm={() => remove(policy.name)}
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
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  {ACTIONS.map((action) => (
                    <div key={action} className="rounded-md border bg-muted/20 px-2 py-1.5">
                      <p
                        className="truncate text-[10px] tracking-wide text-muted-foreground uppercase"
                        title={action}
                      >
                        {ACTION_LABELS[action]}
                      </p>
                      <EffectBadge effect={policy[action]} />
                    </div>
                  ))}
                </div>
                {policy.shell_rules.length > 0 && (
                  <div className="space-y-1.5">
                    {policy.shell_rules.map((rule) => (
                      <div
                        key={`${rule.pattern}-${rule.effect}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
                      >
                        <code className="truncate">{rule.pattern}</code>
                        <EffectBadge effect={rule.effect} />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialog !== null && (
        <PolicyDialog
          key={dialog === "new" ? "new" : dialog.name}
          policy={dialog === "new" ? undefined : dialog}
          onClose={() => setDialog(null)}
          onSave={(policyName, body) =>
            save(`/policies/${dialog === "new" ? policyName : dialog.name}`, body)
          }
        />
      )}
    </div>
  );
}

function PolicyDialog({
  policy,
  onClose,
  onSave,
}: {
  policy?: PolicyRecord;
  onClose: () => void;
  onSave: (name: string, body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(policy?.name ?? "");
  const [effects, setEffects] = useState<Record<ActionKey, string>>(
    Object.fromEntries(ACTIONS.map((action) => [action, policy?.[action] ?? "inherit"])) as Record<
      ActionKey,
      string
    >,
  );
  const [rules, setRules] = useState<ShellRule[]>(policy?.shell_rules ?? []);

  const setEffect = (action: ActionKey, value: string) => {
    setEffects((current) => ({ ...current, [action]: value }));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{policy === undefined ? "新增策略" : `编辑策略 ${policy.name}`}</DialogTitle>
          <DialogDescription>
            留空表示继承上一级；shell_rules 最后匹配，适合放精确 allow/deny。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto py-2">
          <div>
            <Label className="mb-2 block text-xs text-muted-foreground">策略名称</Label>
            <Input
              value={name}
              disabled={policy !== undefined}
              placeholder="standard"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {ACTIONS.map((action) => (
              <div key={action}>
                <Label className="mb-1.5 block font-mono text-[11px] text-muted-foreground">
                  {action}
                </Label>
                <Select value={effects[action]} onValueChange={(value) => setEffect(action, value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">继承</SelectItem>
                    <SelectItem value="allow">allow</SelectItem>
                    <SelectItem value="ask">ask</SelectItem>
                    <SelectItem value="deny">deny</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Shell 规则</p>
                <p className="text-xs text-muted-foreground">按顺序写入，越靠后优先级越高。</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRules((current) => [...current, { pattern: "", effect: "ask" }])}
              >
                <Plus /> 添加
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                还没有 shell 规则。
              </p>
            ) : (
              rules.map((rule, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: shell rules are edited in place and have no stable id.
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={rule.pattern}
                    placeholder="git status *"
                    className="font-mono text-xs"
                    onChange={(event) =>
                      setRules((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, pattern: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <Select
                    value={rule.effect}
                    onValueChange={(value) =>
                      setRules((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, effect: value as PermissionEffect }
                            : item,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">allow</SelectItem>
                      <SelectItem value="ask">ask</SelectItem>
                      <SelectItem value="deny">deny</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      setRules((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                  >
                    <X />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={name.trim().length === 0}
            onClick={() => {
              const output: Record<string, unknown> = {};
              for (const action of ACTIONS) {
                const value = effects[action];
                if (value !== "inherit") output[action] = value;
              }
              output.shell_rules = rules.filter((rule) => rule.pattern.trim().length > 0);
              onSave(name.trim(), output);
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EffectBadge({ effect }: { effect?: PermissionEffect }) {
  if (effect === undefined) return <span className="text-xs text-muted-foreground">继承</span>;
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
        effect === "allow" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        effect === "ask" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        effect === "deny" && "bg-rose-500/15 text-rose-600 dark:text-rose-400",
      )}
    >
      {effect}
    </span>
  );
}
