import type {
  PluginUiApiRequest,
  PluginUiApiResponse,
  PluginUiConfirmParams,
  PluginUiContext,
  PluginUiError,
  PluginUiFormEntry,
  PluginUiHttpMethod,
  PluginUiMethod,
  PluginUiMethodParams,
  PluginUiMethodResult,
  PluginUiNavigateParams,
  PluginUiRequestBody,
  PluginUiResponseBody,
  PluginUiTheme,
  PluginUiToastParams,
} from "@opencode-qq/plugin-sdk/ui-protocol";

const PROTOCOL = 1 as const;
const DEFAULT_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 12_000;

export interface ConnectPluginUiOptions {
  timeoutMs?: number;
  /** Apply the core CSS variables automatically. Defaults to true. */
  applyTheme?: boolean;
}

export interface PluginUiBridgeOptions {
  port: MessagePort;
  context: PluginUiContext;
  /** Apply host theme events to document.documentElement. Defaults to true. */
  applyTheme?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: number;
}

export class PluginUiApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];

  constructor(status: number, code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "PluginUiApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Unsubscribe = () => void;

/**
 * Promise-based capability client for a plugin iframe.
 *
 * The iframe never receives the admin session cookie or CSRF token. Every API
 * call is brokered by the parent, which adds CSRF and restricts the path to the
 * current plugin.
 */
export class PluginUiBridge {
  readonly context: PluginUiContext;
  readonly api: PluginUiApi;
  readonly storage: PluginUiStorage;
  readonly ui: PluginUiUi;

  readonly #port: MessagePort;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
  readonly #applyThemeEvents: boolean;
  #closed = false;

  constructor(options: PluginUiBridgeOptions) {
    this.context = options.context;
    this.#port = options.port;
    this.#applyThemeEvents = options.applyTheme !== false;
    this.#port.onmessage = (event: MessageEvent) => this.#handleMessage(event.data);
    this.#port.start();
    this.api = new PluginUiApi(this);
    this.storage = new PluginUiStorage(this);
    this.ui = new PluginUiUi(this);
  }

  request<M extends PluginUiMethod>(
    method: M,
    params: PluginUiMethodParams<M>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<PluginUiMethodResult<M>> {
    if (this.#closed) {
      return Promise.reject(new Error("plugin UI bridge is closed"));
    }
    const id = requestId();
    return new Promise<PluginUiMethodResult<M>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`plugin UI request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.#port.postMessage({ type: "opencode-qq-ui:request", id, method, params });
    });
  }

  onThemeChange(handler: (theme: PluginUiTheme) => void): Unsubscribe {
    return this.#on("theme", handler as (data: unknown) => void);
  }

  onNavigate(handler: (event: PluginUiNavigateParams) => void): Unsubscribe {
    return this.#on("navigate", handler as (data: unknown) => void);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("plugin UI bridge closed"));
      this.#pending.delete(id);
    }
    this.#port.onmessage = null;
    this.#port.close();
    this.#listeners.clear();
  }

  #on(event: string, handler: (data: unknown) => void): Unsubscribe {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(handler);
    this.#listeners.set(event, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#listeners.delete(event);
    };
  }

  #handleMessage(data: unknown): void {
    if (!isRecord(data)) return;
    if (data.type === "opencode-qq-ui:response") {
      const id = typeof data.id === "string" ? data.id : "";
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      window.clearTimeout(pending.timer);
      if (data.ok === true) {
        pending.resolve(data.result);
      } else {
        pending.reject(toPluginError(data.error));
      }
      return;
    }
    if (data.type === "opencode-qq-ui:event" && typeof data.event === "string") {
      if (data.event === "theme" && this.#applyThemeEvents && isTheme(data.data)) {
        applyTheme(data.data);
      }
      const handlers = this.#listeners.get(data.event);
      if (handlers === undefined) return;
      for (const handler of handlers) handler(data.data);
    }
  }
}

export class PluginUiApi {
  readonly #bridge: PluginUiBridge;

  constructor(bridge: PluginUiBridge) {
    this.#bridge = bridge;
  }

  request(request: PluginUiApiRequest): Promise<PluginUiApiResponse> {
    return this.#bridge.request("api.request", request, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async get<T = unknown>(
    path: string,
    query?: PluginUiApiRequest["query"],
  ): Promise<T> {
    return unwrap<T>(await this.request({ method: "GET", path, ...(query ? { query } : {}) }));
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return unwrap<T>(await this.request(withBody("POST", path, body)));
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return unwrap<T>(await this.request(withBody("PUT", path, body)));
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return unwrap<T>(await this.request(withBody("PATCH", path, body)));
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return unwrap<T>(await this.request({ method: "DELETE", path }));
  }

  async upload<T = unknown>(path: string, form: FormData): Promise<T> {
    const entries: PluginUiFormEntry[] = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        entries.push({ name, value });
      } else {
        entries.push({
          name,
          value: {
            kind: "file",
            name: value.name,
            type: value.type,
            data: await value.arrayBuffer(),
          },
        });
      }
    }
    return unwrap<T>(
      await this.request({
        method: "POST",
        path,
        body: { kind: "form", entries },
      }),
    );
  }

  async blob(path: string, query?: PluginUiApiRequest["query"]): Promise<Blob> {
    const response = await this.request({ method: "GET", path, ...(query ? { query } : {}) });
    if (response.status >= 400) throw responseError(response);
    if (response.body.kind !== "binary") {
      throw new PluginUiApiError(response.status, "not_binary", "插件资源不是二进制响应。");
    }
    return new Blob([response.body.data], {
      type: response.contentType || "application/octet-stream",
    });
  }
}

export class PluginUiStorage {
  readonly #bridge: PluginUiBridge;

  constructor(bridge: PluginUiBridge) {
    this.#bridge = bridge;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const result = await this.#bridge.request("storage.get", { key });
    return (result.value ?? null) as T | null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.#bridge.request("storage.set", { key, value });
  }

  async remove(key: string): Promise<void> {
    await this.#bridge.request("storage.remove", { key });
  }
}

export class PluginUiUi {
  readonly #bridge: PluginUiBridge;

  constructor(bridge: PluginUiBridge) {
    this.#bridge = bridge;
  }

  async toast(message: string, type: NonNullable<PluginUiToastParams["type"]> = "info") {
    await this.#bridge.request("ui.toast", { message, type });
  }

  async confirm(params: PluginUiConfirmParams): Promise<boolean> {
    const result = await this.#bridge.request("ui.confirm", params);
    return result.confirmed;
  }

  async openExternal(url: string): Promise<boolean> {
    const result = await this.#bridge.request("ui.openExternal", { url });
    return result.ok;
  }

  async navigate(path: string): Promise<void> {
    await this.#bridge.request("ui.navigate", { path });
  }
}

const appliedTokens = new Set<string>();

export function applyTheme(theme: PluginUiTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme.mode === "dark");
  root.dataset.opencodeQqTheme = theme.mode;
  root.style.colorScheme = theme.mode;
  const next = new Set<string>();
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (name.startsWith("--") && typeof value === "string") {
      root.style.setProperty(name, value);
      next.add(name);
    }
  }
  for (const name of appliedTokens) {
    if (!next.has(name)) root.style.removeProperty(name);
  }
  appliedTokens.clear();
  for (const name of next) appliedTokens.add(name);
}

/**
 * Perform the iframe handshake and return a capability bridge.
 *
 * The nonce is read from `location.hash` (`#__qq_ui=...`) and verified by the
 * parent before it transfers a MessagePort. All subsequent calls stay on that
 * private port.
 */
export async function connectPluginUi(
  options: ConnectPluginUiOptions = {},
): Promise<PluginUiBridge> {
  if (window.parent === window) {
    throw new Error("插件页面必须嵌入 OpenCode QQ 管理台 iframe 中运行。");
  }
  const nonce =
    new URLSearchParams(location.search).get("__qq_ui") ??
    new URLSearchParams(location.hash.replace(/^#/, "")).get("__qq_ui") ??
    "";
  return new Promise<PluginUiBridge>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      reject(new Error("插件页面等待核心 bridge 超时。"));
    }, options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      reject(error);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!isRecord(event.data) || event.data.type !== "opencode-qq-ui:init") return;
      if (event.data.protocol !== PROTOCOL) {
        fail(new Error(`插件 UI 协议版本不兼容：${String(event.data.protocol)}`));
        return;
      }
      const port = event.data.port as MessagePort | null;
      if (port === null || typeof port?.postMessage !== "function") {
        fail(new Error("核心没有传回 MessagePort。"));
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      const context = event.data.context as PluginUiContext;
      const bridge = new PluginUiBridge({
        port,
        context,
        ...(options.applyTheme !== undefined ? { applyTheme: options.applyTheme } : {}),
      });
      if (options.applyTheme !== false) applyTheme(context.theme);
      resolve(bridge);
    };

    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      { type: "opencode-qq-ui:ready", protocol: PROTOCOL, nonce },
      "*",
    );
  });
}

function withBody(method: PluginUiHttpMethod, path: string, body: unknown): PluginUiApiRequest {
  if (body === undefined) return { method, path };
  return { method, path, body: toRequestBody(body) };
}

function toRequestBody(body: unknown): PluginUiRequestBody {
  if (body instanceof ArrayBuffer) return { kind: "binary", data: body };
  if (ArrayBuffer.isView(body)) {
    return {
      kind: "binary",
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    // Blob has no synchronous bytes; callers should use api.upload for files.
    throw new Error("Blob bodies are not synchronous; use FormData with api.upload instead.");
  }
  return { kind: "json", value: body };
}

function unwrap<T>(response: PluginUiApiResponse): T {
  if (response.status >= 400) throw responseError(response);
  const body = response.body;
  if (body.kind === "json") return body.value as T;
  if (body.kind === "text") return body.value as T;
  return body.data as T;
}

function responseError(response: PluginUiApiResponse): PluginUiApiError {
  if (response.body.kind === "json" && isRecord(response.body.value)) {
    const value = response.body.value;
    const code = typeof value.error === "string" ? value.error : "http_error";
    const message =
      typeof value.message === "string"
        ? value.message
        : `插件 API 请求失败（HTTP ${response.status}）`;
    const details = Array.isArray(value.details)
      ? value.details.filter((item): item is string => typeof item === "string")
      : [];
    return new PluginUiApiError(response.status, code, message, details);
  }
  return new PluginUiApiError(
    response.status,
    "http_error",
    `插件 API 请求失败（HTTP ${response.status}）`,
  );
}

function toPluginError(value: unknown): Error {
  if (!isRecord(value)) return new Error("插件桥接请求失败");
  const message = typeof value.message === "string" ? value.message : "插件桥接请求失败";
  const status = typeof value.status === "number" ? value.status : 0;
  const code = typeof value.code === "string" ? value.code : "bridge_error";
  const details = Array.isArray(value.details)
    ? value.details.filter((item): item is string => typeof item === "string")
    : [];
  return new PluginUiApiError(status, code, message, details);
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTheme(value: unknown): value is PluginUiTheme {
  return (
    isRecord(value) &&
    (value.mode === "light" || value.mode === "dark") &&
    isRecord(value.tokens)
  );
}

export type {
  PluginUiApiRequest,
  PluginUiApiResponse,
  PluginUiConfirmParams,
  PluginUiContext,
  PluginUiError,
  PluginUiNavigateParams,
  PluginUiRequestBody,
  PluginUiResponseBody,
  PluginUiTheme,
  PluginUiToastParams,
};
