import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/api/client";

interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useApiQuery<T>(
  path: string | null,
  options: { intervalMs?: number; enabled?: boolean } = {},
) {
  const { intervalMs, enabled = true } = options;
  const [state, setState] = useState<QueryState<T>>({ data: null, error: null, loading: true });
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (silent = false) => {
      if (path === null || !enabled) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }
      const requestId = ++requestRef.current;
      if (!silent) setState((current) => ({ ...current, loading: current.data === null }));
      try {
        const data = await api.get<T>(path);
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setState({ data, error: null, loading: false });
      } catch (error) {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setState((current) => ({ ...current, error: errorMessage(error), loading: false }));
      }
    },
    [path, enabled],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (intervalMs === undefined || path === null || !enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, path, enabled, refresh]);

  return {
    ...state,
    refresh,
    setData: (data: T | null) => setState((current) => ({ ...current, data })),
  };
}
