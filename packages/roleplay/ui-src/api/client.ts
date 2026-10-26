import { PluginUiApiError } from "@opencode-qq/plugin-ui";
import { getPluginBridge } from "@rp/bridge";

const PREFIXES = ["/admin/api/plugins/roleplay", "/plugins/roleplay"];

function normalize(path: string): { path: string; query?: Record<string, string> } {
  let target = path;
  for (const prefix of PREFIXES) {
    if (target.startsWith(prefix)) {
      target = target.slice(prefix.length) || "/";
      break;
    }
  }
  const index = target.indexOf("?");
  if (index < 0) return { path: target };
  const params = new URLSearchParams(target.slice(index + 1));
  const query: Record<string, string> = {};
  for (const [key, value] of params) query[key] = value;
  return { path: target.slice(0, index), query };
}

function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
}

export const api = {
  get<T>(path: string): Promise<T> {
    const target = normalize(path);
    return call(() => getPluginBridge().api.get<T>(target.path, target.query));
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    const target = normalize(path);
    return call(() =>
      getPluginBridge().api.post<T>(
        target.query === undefined
          ? target.path
          : `${target.path}?${new URLSearchParams(target.query).toString()}`,
        body,
      ),
    );
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    const target = normalize(path);
    return call(() =>
      getPluginBridge().api.put<T>(
        target.query === undefined
          ? target.path
          : `${target.path}?${new URLSearchParams(target.query).toString()}`,
        body,
      ),
    );
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    const target = normalize(path);
    return call(() =>
      getPluginBridge().api.patch<T>(
        target.query === undefined
          ? target.path
          : `${target.path}?${new URLSearchParams(target.query).toString()}`,
        body,
      ),
    );
  },
  delete<T>(path: string): Promise<T> {
    const target = normalize(path);
    return call(() =>
      getPluginBridge().api.delete<T>(
        target.query === undefined
          ? target.path
          : `${target.path}?${new URLSearchParams(target.query).toString()}`,
      ),
    );
  },
  upload<T>(path: string, form: FormData): Promise<T> {
    const target = normalize(path);
    return call(() =>
      getPluginBridge().api.upload<T>(
        target.query === undefined
          ? target.path
          : `${target.path}?${new URLSearchParams(target.query).toString()}`,
        form,
      ),
    );
  },
  blob(path: string): Promise<Blob> {
    const target = normalize(path);
    return call(() => getPluginBridge().api.blob(target.path, target.query));
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof PluginUiApiError) {
    return error.details.length > 0
      ? `${error.message} ${error.details.join("；")}`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
