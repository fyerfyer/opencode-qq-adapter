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
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Sent as X-Config-Hash for optimistic YAML edits. */
  configHash?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken !== null) headers["X-CSRF-Token"] = csrfToken;
  if (options.configHash !== undefined) headers["X-Config-Hash"] = options.configHash;

  const response = await fetch(`/admin/api${path}`, {
    method,
    credentials: "same-origin",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("admin:unauthorized"));
    }
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
  put: <T>(path: string, body: unknown, configHash?: string) =>
    request<T>(path, {
      method: "PUT",
      body,
      ...(configHash !== undefined ? { configHash } : {}),
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
