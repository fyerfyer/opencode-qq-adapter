import type { PluginInfo } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export interface ConfigDialogState {
  plugin: PluginInfo;
  text: string;
  hash: string;
  error: string | null;
  snapshotError: string | null;
}

export interface PluginOptionsDialogProps {
  state: ConfigDialogState | null;
  busy: boolean;
  onChange: (patch: Partial<ConfigDialogState>) => void;
  onClose: () => void;
  onSave: () => void;
}

export function PluginOptionsDialog({
  state,
  busy,
  onChange,
  onClose,
  onSave,
}: PluginOptionsDialogProps) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>插件配置 · {state?.plugin.name}</DialogTitle>
          <DialogDescription>
            编辑 YAML 中 plugins.{state?.plugin.id}.options；保存前由插件 schema
            校验，并触发热加载。
          </DialogDescription>
        </DialogHeader>
        {state?.snapshotError !== null && state?.snapshotError !== undefined && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            当前 options 无法通过插件校验：{state.snapshotError}
          </p>
        )}
        <Textarea
          value={state?.text ?? ""}
          onChange={(event) => onChange({ text: event.target.value, error: null })}
          spellCheck={false}
          className="min-h-72 resize-y font-mono text-xs leading-6"
        />
        {state?.error !== null && state?.error !== undefined && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {state.error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={onSave}>
            保存并热加载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
