import { ImagePlus, LoaderCircle, Pencil, Search, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import type { RoleplayPersonaSummary, RoleplayStickerFile, RoleplayStickerSet } from "@/api/types";
import { ConfirmDelete } from "@/components/common/confirm-delete";
import { ErrorState, LoadingState } from "@/components/common/data-state";
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
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDate } from "@/lib/utils";
import { EmptyHint, Field, SizeBadge, StickerImage } from "./shared";

export function StickersTab({ initialPersonaId }: { initialPersonaId?: string | null }) {
  const personas = useApiQuery<{ personas: RoleplayPersonaSummary[] }>(
    "/plugins/roleplay/personas",
  );
  const [personaId, setPersonaId] = useState(initialPersonaId ?? "");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameEmotion, setRenameEmotion] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: RoleplayStickerFile; emotion: string } | null>(
    null,
  );
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (personaId.length === 0 && personas.data !== null) {
      setPersonaId(personas.data.personas[0]?.id ?? "_global");
    }
  }, [personaId, personas.data]);

  const stickers = useApiQuery<RoleplayStickerSet>(
    personaId.length > 0
      ? `/plugins/roleplay/personas/${encodeURIComponent(personaId)}/stickers`
      : null,
  );

  useEffect(() => {
    if (initialPersonaId !== undefined && initialPersonaId !== null) setPersonaId(initialPersonaId);
  }, [initialPersonaId]);

  const groups = useMemo(() => {
    if (stickers.data === null) return [];
    const target = search.trim().toLowerCase();
    const all = [
      ...stickers.data.emotions,
      ...stickers.data.global.map((group) => ({
        ...group,
        emotion: `_global/${group.emotion}`,
      })),
    ];
    if (target.length === 0) return all;
    return all.filter(
      (group) =>
        group.emotion.toLowerCase().includes(target) ||
        group.files.some((file) => file.name.toLowerCase().includes(target)),
    );
  }, [search, stickers.data]);

  const total =
    stickers.data === null
      ? 0
      : stickers.data.emotions.reduce((sum, group) => sum + group.files.length, 0) +
        stickers.data.global.reduce((sum, group) => sum + group.files.length, 0);

  const removeSticker = async (emotion: string, name: string) => {
    try {
      await api.delete(
        `/plugins/roleplay/personas/${encodeURIComponent(personaId)}/stickers/${encodeURIComponent(emotion)}/${encodeURIComponent(name)}`,
      );
      toast.success("表情已删除");
      await stickers.refresh(true);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const testSticker = async (emotion: string) => {
    try {
      const result = await api.post<{ messageId: string }>("/plugins/roleplay/test/sticker", {
        persona: personaId,
        emotion,
      });
      toast.success(`已发送到 QQ（消息 ${result.messageId}）`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  if (personas.loading && personas.data === null) return <LoadingState rows={5} />;
  if (personas.error !== null && personas.data === null) {
    return <ErrorState message={personas.error} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={personaId} onValueChange={setPersonaId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="选择角色" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_global">全局回退（_global）</SelectItem>
            {(personas.data?.personas ?? []).map((persona) => (
              <SelectItem key={persona.id} value={persona.id}>
                {persona.name}（{persona.id}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="过滤情绪或文件名"
          />
        </div>
        <Badge variant="secondary">{total} 张</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void stickers.refresh(true)}>
            刷新
          </Button>
          <Button size="sm" disabled={personaId.length === 0} onClick={() => setUploadOpen(true)}>
            <ImagePlus /> 上传表情
          </Button>
        </div>
      </div>

      {stickers.loading && stickers.data === null && <LoadingState rows={4} />}
      {stickers.error !== null && <ErrorState message={stickers.error} />}
      {stickers.data !== null && groups.length === 0 && (
        <EmptyHint
          title={search.length > 0 ? "没有匹配的表情" : "还没有表情素材"}
          description={
            search.length > 0
              ? "换个情绪名或文件名试试。"
              : "上传图片到某个情绪目录，或在角色卡导入时携带 CCv3 emotion assets。"
          }
          icon={<ImagePlus className="size-5" />}
          action={
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <ImagePlus /> 上传第一张
            </Button>
          }
        />
      )}

      {groups.map((group) => {
        const [groupPersona, groupEmotion] = splitEmotion(group.emotion);
        const canMutate = groupPersona !== "_global" || personaId === "_global";
        return (
          <Card key={group.emotion}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {groupEmotion}
                  <Badge variant="outline">{group.files.length} 张</Badge>
                  {groupPersona === null && <Badge variant="secondary">角色专属</Badge>}
                  {groupPersona !== null && <Badge variant="secondary">全局回退</Badge>}
                </CardTitle>
                <CardDescription>
                  点击图片预览；可发送一张到已绑定的 QQ 会话做测试。
                </CardDescription>
              </div>
              <div className="flex gap-1">
                {personaId !== "_global" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void testSticker(groupEmotion)}
                  >
                    <Send /> 测试
                  </Button>
                )}
                {canMutate && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="重命名情绪"
                    onClick={() => setRenameEmotion(groupEmotion)}
                  >
                    <Pencil />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 pt-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {group.files.map((file) => (
                <div
                  key={`${groupEmotion}/${file.name}`}
                  className="overflow-hidden rounded-lg border"
                >
                  <button
                    type="button"
                    className="flex aspect-square w-full items-center justify-center bg-muted/30 p-2"
                    onClick={() => setPreview({ file, emotion: groupEmotion })}
                  >
                    <StickerImage src={file.thumbnailUrl} alt={file.name} />
                  </button>
                  <div className="flex items-center justify-between gap-1 border-t p-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[10px]">{file.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatDate(file.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <SizeBadge bytes={file.size} />
                      <ConfirmDelete
                        title="删除这张表情？"
                        description="会直接删除文件。若该情绪目录为空，仍会保留空目录。"
                        onConfirm={() => removeSticker(groupEmotion, file.name)}
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
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        personaId={personaId}
        onUploaded={() => void stickers.refresh(true)}
      />
      <RenameEmotionDialog
        emotion={renameEmotion}
        personaId={personaId}
        onClose={() => setRenameEmotion(null)}
        onRenamed={() => void stickers.refresh(true)}
      />
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.file.name}</DialogTitle>
            <DialogDescription>
              {preview?.emotion} · {preview?.file.size} bytes
            </DialogDescription>
          </DialogHeader>
          {preview !== null && (
            <div className="flex max-h-[70vh] items-center justify-center overflow-hidden rounded-lg border bg-muted/30 p-4">
              <img
                src={preview.file.url}
                alt={preview.file.name}
                className="max-h-[64vh] object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  personaId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personaId: string;
  onUploaded: () => void;
}) {
  const [emotion, setEmotion] = useState("happy");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const dropzone = useDropzone({
    accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp"] },
    maxFiles: 20,
    onDrop: (accepted) => setFiles((current) => [...current, ...accepted]),
  });

  const upload = async () => {
    if (files.length === 0) {
      toast.error("请选择图片");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const result = await api.upload<{
        uploaded: number;
        duplicates: number;
        rejected: Array<{ name: string; reason: string }>;
      }>(
        `/plugins/roleplay/personas/${encodeURIComponent(personaId)}/stickers/${encodeURIComponent(emotion)}`,
        form,
      );
      const rejected = result.rejected.length > 0 ? `，拒绝 ${result.rejected.length} 张` : "";
      toast.success(`上传 ${result.uploaded} 张，重复 ${result.duplicates} 张${rejected}`);
      setFiles([]);
      onOpenChange(false);
      onUploaded();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>上传表情素材</DialogTitle>
          <DialogDescription>
            目标：{personaId === "_global" ? "全局回退" : personaId}。文件会按 SHA-256 去重。
          </DialogDescription>
        </DialogHeader>
        <Field label="情绪名" hint="小写字母、数字、下划线或短横线，例如 happy / shy / angry。">
          <Input value={emotion} onChange={(event) => setEmotion(event.target.value)} />
        </Field>
        <div
          {...dropzone.getRootProps()}
          className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/20 p-4 text-center text-sm"
        >
          <input {...dropzone.getInputProps()} />
          <ImagePlus className="size-5 text-muted-foreground" />
          <p>拖入图片或点击选择（最多 20 张）</p>
          <p className="text-[11px] text-muted-foreground">
            PNG / JPEG / GIF / WebP，单张 ≤ 20 MiB
          </p>
        </div>
        {files.length > 0 && (
          <div className="max-h-40 overflow-auto rounded-lg border p-2">
            {files.map((file) => (
              <div
                key={`${file.name}-${file.size}`}
                className="flex items-center justify-between gap-2 py-1 text-xs"
              >
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setFiles((current) => current.filter((item) => item !== file))}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={uploading || files.length === 0} onClick={() => void upload()}>
            {uploading ? <LoaderCircle className="animate-spin" /> : <ImagePlus />} 上传
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameEmotionDialog({
  emotion,
  personaId,
  onClose,
  onRenamed,
}: {
  emotion: string | null;
  personaId: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [next, setNext] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNext(emotion ?? "");
  }, [emotion]);

  const submit = async () => {
    if (emotion === null || next.trim().length === 0) return;
    setSaving(true);
    try {
      await api.patch(
        `/plugins/roleplay/personas/${encodeURIComponent(personaId)}/stickers/${encodeURIComponent(emotion)}`,
        { emotion: next.trim().toLowerCase() },
      );
      toast.success("情绪目录已重命名");
      onClose();
      onRenamed();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={emotion !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名情绪</DialogTitle>
          <DialogDescription>目录名会变，已有表情文件保持不变。</DialogDescription>
        </DialogHeader>
        <Field label="新情绪名">
          <Input value={next} onChange={(event) => setNext(event.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? <LoaderCircle className="animate-spin" /> : null} 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function splitEmotion(value: string): [string | null, string] {
  if (value.startsWith("_global/")) return ["_global", value.slice("_global/".length)];
  return [null, value];
}
