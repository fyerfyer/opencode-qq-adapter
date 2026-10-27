import { FolderSearch, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface LocalPathFormProps {
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onInspect: () => void;
}

export function LocalPathForm({ value, busy, error, onChange, onInspect }: LocalPathFormProps) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onInspect();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="plugin-local-path">插件目录</Label>
        <div className="flex gap-2">
          <Input
            id="plugin-local-path"
            value={value}
            placeholder="/home/me/code/my-plugin"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="font-mono text-xs"
            onChange={(event) => onChange(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || value.trim().length === 0}>
            {busy ? <LoaderCircle className="animate-spin" /> : <FolderSearch />} 检查
          </Button>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        本地目录不会复制代码，只写入 YAML 配置；修改代码后，使用插件卡片菜单中的“重新加载代码”。
      </p>
      {error !== null ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
