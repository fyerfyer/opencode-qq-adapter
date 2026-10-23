import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "error" | "muted" | "info";

const tones: Record<StatusTone, string> = {
  ok: "bg-emerald-500 shadow-emerald-500/40",
  warn: "bg-amber-500 shadow-amber-500/40",
  error: "bg-rose-500 shadow-rose-500/40",
  muted: "bg-zinc-400 shadow-zinc-400/20",
  info: "bg-foreground shadow-foreground/20",
};

export function StatusDot({
  tone = "muted",
  pulse = false,
  className,
}: {
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative flex size-2.5", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            tones[tone],
          )}
        />
      )}
      <span
        className={cn("relative inline-flex size-2.5 rounded-full shadow-[0_0_12px]", tones[tone])}
      />
    </span>
  );
}
