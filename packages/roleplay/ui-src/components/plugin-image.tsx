import { ImageOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@rp/api/client";
import { cn } from "@/lib/utils";

const cache = new Map<string, Promise<string>>();
let revokeHookInstalled = false;

function loadBlobUrl(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const promise = api.blob(path).then((blob) => URL.createObjectURL(blob));
  cache.set(path, promise);
  promise.catch(() => cache.delete(path));
  if (!revokeHookInstalled && typeof window !== "undefined") {
    revokeHookInstalled = true;
    window.addEventListener("pagehide", () => {
      for (const item of cache.values()) {
        void item.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
      }
      cache.clear();
    });
  }
  return promise;
}

export function PluginImage({
  path,
  alt,
  className,
  fallback,
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(() =>
    path !== null && path !== undefined && /^(data|blob):/.test(path) ? path : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (path === null || path === undefined || path.length === 0) {
      setUrl(null);
      return;
    }
    if (/^(data|blob):/.test(path)) {
      setUrl(path);
      return;
    }
    let active = true;
    setUrl(null);
    void loadBlobUrl(path)
      .then((next) => {
        if (active) setUrl(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [path]);

  if (failed || (url === null && (path === null || path === undefined))) {
    return (
      fallback ?? (
        <div
          className={cn(
            "flex items-center justify-center bg-muted/40 text-muted-foreground",
            className,
          )}
        >
          <ImageOff className="size-4" />
        </div>
      )
    );
  }
  if (url === null) {
    return <div className={cn("animate-pulse bg-muted/40", className)} aria-label={alt} />;
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
