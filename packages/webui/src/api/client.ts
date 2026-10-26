let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];

  constructor(status: number, code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Sent as X-Config-Hash for optimistic YAML edits. */
  configHash?: string;
  signal?: AbortSignal;
}

export interface ApiFetchOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Low-level authenticated fetch used by the plugin iframe bridge. It injects
 * CSRF for unsafe methods but leaves body/header handling to the caller.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (method !== "GET" && method !== "HEAD" && csrfToken !== null) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetch(`/admin/api${path}`, {
    method,
    credentials: "same-origin",
    headers,
    ...(options.body !== undefined && options.body !== null ? { body: options.body } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent("admin:unauthorized"));
  }
  return response;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  const isForm = options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  if (options.configHash !== undefined) headers["X-Config-Hash"] = options.configHash;

  const response = await apiFetch(path, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: isForm ? (options.body as FormData) : JSON.stringify(options.body) }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    const body = payload as
      | { error?: string; message?: string; details?: string[] }
      | string
      | null;
    const code =
      typeof body === "object" && body !== null ? (body.error ?? "http_error") : "http_error";
    const message =
      typeof body === "object" && body !== null
        ? (body.message ?? `请求失败（HTTP ${response.status}）`)
        : `请求失败（HTTP ${response.status}）`;
    const details =
      typeof body === "object" && body !== null && Array.isArray(body.details) ? body.details : [];
    throw new ApiError(response.status, code, message, details);
  }

  return payload as T;
}

export interface SessionInfo {
  authenticated: true;
  username: string;
  csrfToken: string;
  expiresAt: number;
  mustChangePassword: boolean;
}

export const api = {
  session: () => request<SessionInfo>("/auth/session"),
  login: (password: string) =>
    request<SessionInfo>("/auth/login", { method: "POST", body: { password } }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ csrfToken: string }>("/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", ...(body !== undefined ? { body } : {}) }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form }),
  put: <T>(path: string, body: unknown, configHash?: string) =>
    request<T>(path, {
      method: "PUT",
      body,
      ...(configHash !== undefined ? { configHash } : {}),
    }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body,
    }),
  delete: <T>(path: string, configHash?: string) =>
    request<T>(path, {
      method: "DELETE",
      ...(configHash !== undefined ? { configHash } : {}),
    }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.details.length > 0
      ? `${error.message} ${error.details.join("；")}`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
