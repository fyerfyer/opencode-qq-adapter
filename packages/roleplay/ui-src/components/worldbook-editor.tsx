import { BookOpen, LoaderCircle, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { RoleplayWorldbookEntry } from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@rp/api/client";
import { EmptyHint, Field } from "@rp/components/shared";
import { toast } from "@rp/toast";

type WholeWordMode = "inherit" | "true" | "false";

interface Draft {
  name: string;
  keys: string;
  secondaryKeys: string;
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  caseSensitive: boolean;
  matchWholeWords: WholeWordMode;
  priority: string;
  insertionOrder: string;
  position: "before_char" | "after_char";
}

const EMPTY_DRAFT: Draft = {
  name: "",
  keys: "",
  secondaryKeys: "",
  content: "",
  enabled: true,
  constant: false,
  selective: true,
  caseSensitive: false,
  matchWholeWords: "inherit",
  priority: "100",
  insertionOrder: "0",
  position: "before_char",
};

export function WorldbookEditor({
  personaId,
  entries: incoming,
  onSaved,
}: {
  personaId: string;
  entries: RoleplayWorldbookEntry[];
  onSaved: () => void;
}) {
  const [entries, setEntries] = useState<RoleplayWorldbookEntry[]>(incoming);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ index: number | null; draft: Draft } | null>(null);

  useEffect(() => {
    setEntries(incoming);
    setDirty(false);
  }, [incoming]);

  const openCreate = () => {
    setEditing({
      index: null,
      draft: {
        ...EMPTY_DRAFT,
        insertionOrder: String(entries.length),
      },
    });
  };

  const openEdit = (index: number) => {
    const entry = entries[index];
    if (entry === undefined) return;
    setEditing({ index, draft: toDraft(entry) });
  };

  const applyDraft = () => {
    if (editing === null) return;
    const parsed = parseDraft(editing.draft);
    if (!parsed.ok) {
      toast.error(parsed.message);
      return;
    }
    setEntries((current) => {
      const next = [...current];
      if (editing.index === null) next.push(parsed.entry);
      else next[editing.index] = parsed.entry;
      return next;
    });
    setDirty(true);
    setEditing(null);
  };

  const remove = (index: number) => {
    setEntries((current) => current.filter((_, item) => item !== index));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.put<{ entries: RoleplayWorldbookEntry[] }>(
        `/plugins/roleplay/personas/${encodeURIComponent(personaId)}/worldbook`,
        { entries },
      );
      setEntries(result.entries);
      setDirty(false);
      toast.success(`世界书已保存，共 ${result.entries.length} 条`);
      onSaved();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{entries.length} 条</Badge>
          {dirty && <Badge variant="secondary">有未保存修改</Badge>}
          <span>修改会同时写入 worldbook.json 和 worldbook.md。</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={openCreate}>
            <Plus /> 新增条目
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />} 保存
          </Button>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyHint
          title="世界书为空"
          description="可以新增条目，或从角色卡重新导入 Character Book。"
          icon={<BookOpen />}
          action={
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus /> 新增第一条
            </Button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          {entries.map((entry, index) => (
            <WorldbookRow
              // Entries have no stable id in the card format; index is the editing identity.
              key={`${entry.name}-${index}`}
              entry={entry}
              onEdit={() => openEdit(index)}
              onDelete={() => remove(index)}
              onToggle={(enabled) => {
                setEntries((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, enabled } : item,
                  ),
                );
                setDirty(true);
              }}
            />
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.index === null ? "新增世界书条目" : "编辑世界书条目"}</DialogTitle>
            <DialogDescription>
              关键词命中后注入内容；常驻条目会直接进入上下文。
            </DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <div className="space-y-3">
              <Field label="名称">
                <Input
                  value={editing.draft.name}
                  onChange={(event) =>
                    setEditing({ ...editing, draft: { ...editing.draft, name: event.target.value } })
                  }
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="主关键词" hint="用逗号或换行分隔。">
                  <Textarea
                    value={editing.draft.keys}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, keys: event.target.value },
                      })
                    }
                    className="min-h-20 font-mono text-xs"
                  />
                </Field>
                <Field label="次要关键词" hint="selective 开启时，主+次同时命中才注入。">
                  <Textarea
                    value={editing.draft.secondaryKeys}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, secondaryKeys: event.target.value },
                      })
                    }
                    className="min-h-20 font-mono text-xs"
                  />
                </Field>
              </div>
              <Field label="内容">
                <Textarea
                  value={editing.draft.content}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, content: event.target.value },
                    })
                  }
                  className="min-h-40"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="优先级">
                  <Input
                    type="number"
                    value={editing.draft.priority}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, priority: event.target.value },
                      })
                    }
                  />
                </Field>
                <Field label="插入顺序">
                  <Input
                    type="number"
                    value={editing.draft.insertionOrder}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, insertionOrder: event.target.value },
                      })
                    }
                  />
                </Field>
                <Field label="位置">
                  <Select
                    value={editing.draft.position}
                    onValueChange={(value) =>
                      setEditing({
                        ...editing,
                        draft: {
                          ...editing.draft,
                          position: value === "after_char" ? "after_char" : "before_char",
                        },
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="before_char">角色设定前</SelectItem>
                      <SelectItem value="after_char">角色设定后</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Toggle
                  label="启用"
                  checked={editing.draft.enabled}
                  onChange={(enabled) => setEditing({ ...editing, draft: { ...editing.draft, enabled } })}
                />
                <Toggle
                  label="常驻"
                  checked={editing.draft.constant}
                  onChange={(constant) =>
                    setEditing({ ...editing, draft: { ...editing.draft, constant } })
                  }
                />
                <Toggle
                  label="主 + 次关键词"
                  checked={editing.draft.selective}
                  onChange={(selective) =>
                    setEditing({ ...editing, draft: { ...editing.draft, selective } })
                  }
                />
                <Toggle
                  label="区分大小写"
                  checked={editing.draft.caseSensitive}
                  onChange={(caseSensitive) =>
                    setEditing({ ...editing, draft: { ...editing.draft, caseSensitive } })
                  }
                />
              </div>
              <Field label="整词匹配" hint="继承表示使用插件全局 worldbook_match_whole_words。">
                <Select
                  value={editing.draft.matchWholeWords}
                  onValueChange={(value) =>
                    setEditing({
                      ...editing,
                      draft: {
                        ...editing.draft,
                        matchWholeWords: value as WholeWordMode,
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">继承全局</SelectItem>
                    <SelectItem value="true">开启</SelectItem>
                    <SelectItem value="false">关闭</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={applyDraft}>应用到列表</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function WorldbookRow({
  entry,
  onEdit,
  onDelete,
  onToggle,
}: {
  entry: RoleplayWorldbookEntry;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <details className="group rounded-xl border border-border/60 bg-card/50 p-4 transition-colors open:bg-card/80">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{entry.name}</span>
          {entry.constant && <Badge>常驻</Badge>}
          {entry.selective && <Badge variant="secondary">主+次</Badge>}
          {entry.matchWholeWords === true && <Badge variant="outline">整词</Badge>}
          {!entry.enabled && <Badge variant="destructive">禁用</Badge>}
          <span className="text-[11px] text-muted-foreground">
            优先级 {entry.priority} · 顺序 {entry.insertionOrder} · {entry.position}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Switch checked={entry.enabled} onCheckedChange={onToggle} />
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="编辑条目">
              <Pencil />
            </Button>
            <ConfirmDelete
              title="删除这条世界书？"
              description="保存后会从 worldbook.json 和 worldbook.md 中移除；取消可放弃本次修改。"
              onConfirm={onDelete}
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label="删除条目">
                  <Trash2 />
                </Button>
              }
            />
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

function toDraft(entry: RoleplayWorldbookEntry): Draft {
  return {
    name: entry.name,
    keys: entry.keys.join(", "),
    secondaryKeys: entry.secondaryKeys.join(", "),
    content: entry.content,
    enabled: entry.enabled,
    constant: entry.constant,
    selective: entry.selective,
    caseSensitive: entry.caseSensitive,
    matchWholeWords:
      entry.matchWholeWords === true ? "true" : entry.matchWholeWords === false ? "false" : "inherit",
    priority: String(entry.priority),
    insertionOrder: String(entry.insertionOrder),
    position: entry.position,
  };
}

function parseDraft(
  draft: Draft,
): { ok: true; entry: RoleplayWorldbookEntry } | { ok: false; message: string } {
  const name = draft.name.trim();
  const content = draft.content.trim();
  if (name.length === 0) return { ok: false, message: "世界书条目名称不能为空。" };
  if (content.length === 0) return { ok: false, message: "世界书内容不能为空。" };
  const keys = splitKeys(draft.keys);
  const secondaryKeys = splitKeys(draft.secondaryKeys);
  if (keys.length === 0 && !draft.constant) {
    return { ok: false, message: "非常驻条目至少需要一个主关键词。" };
  }
  const priority = Number(draft.priority);
  const insertionOrder = Number(draft.insertionOrder);
  if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
    return { ok: false, message: "优先级必须是整数。" };
  }
  if (!Number.isFinite(insertionOrder) || !Number.isInteger(insertionOrder)) {
    return { ok: false, message: "插入顺序必须是整数。" };
  }
  return {
    ok: true,
    entry: {
      name,
      keys,
      secondaryKeys,
      content: draft.content,
      enabled: draft.enabled,
      constant: draft.constant,
      selective: draft.selective,
      caseSensitive: draft.caseSensitive,
      ...(draft.matchWholeWords === "inherit"
        ? {}
        : { matchWholeWords: draft.matchWholeWords === "true" }),
      priority,
      insertionOrder,
      position: draft.position,
    },
  };
}

function splitKeys(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
