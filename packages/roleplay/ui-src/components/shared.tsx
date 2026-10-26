import { diffLines } from "diff";
import { ImageIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PluginImage } from "@rp/components/plugin-image";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint !== undefined && <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SwitchField({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint !== undefined && (
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{hint}</p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function MarkdownPreview({ content }: { content: string }) {
  if (content.trim().length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">还没有内容。</p>;
  }
  return (
    <div className="roleplay-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  minHeight = "18rem",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
}) {
  return (
    <Textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="resize-y font-mono text-xs leading-6"
      style={{ minHeight }}
    />
  );
}

export function DiffPreview({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs leading-5">
      {parts.map((part, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: jsdiff parts have no stable id
          key={`${index}-${part.value.length}`}
          className={cn(
            "whitespace-pre-wrap",
            part.added && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
            part.removed && "bg-destructive/10 text-destructive",
            !part.added && !part.removed && "text-muted-foreground",
          )}
        >
          {part.value}
        </div>
      ))}
    </pre>
  );
}

export function StickerImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <PluginImage
      path={src}
      alt={alt}
      className={cn("h-full w-full object-contain", className)}
    />
  );
}

export function SizeBadge({ bytes }: { bytes: number }) {
  const value =
    bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return (
    <Badge variant="outline" className="font-mono text-[10px]">
      {value}
    </Badge>
  );
}

export function EmptyHint({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border bg-muted text-muted-foreground">
        {icon ?? <ImageIcon className="size-5" />}
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
