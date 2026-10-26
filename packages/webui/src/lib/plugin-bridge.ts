import type {
  PluginUiApiResponse,
  PluginUiConfirmParams,
  PluginUiContext,
  PluginUiError,
  PluginUiMethod,
  PluginUiTheme,
  PluginUiToastParams,
} from "@opencode-qq/plugin-sdk/ui-protocol";
import { apiFetch } from "@/api/client";
import type { PluginUiPageDescriptor } from "@/api/types";

const PROTOCOL = 1 as const;
const HANDSHAKE_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STORAGE_BYTES = 256 * 1024;
const STORAGE_KEY = /^[a-zA-Z0-9._:-]{1,128}$/;
const METHODS = new Set<PluginUiMethod>([
  "api.request",
  "storage.get",
  "storage.set",
  "storage.remove",
  "ui.toast",
  "ui.confirm",
  "ui.openExternal",
  "ui.navigate",
]);

export interface PluginBridgeHostOptions {
  iframe: HTMLIFrameElement;
  descriptor: PluginUiPageDescriptor;
  nonce: string;
  getTheme: () => PluginUiTheme;
  toast: (message: string, type: NonNullable<PluginUiToastParams["type"]>) => void;
  confirm: (params: PluginUiConfirmParams) => Promise<boolean>;
  navigate: (path: string) => void;
  onReady?: () => void;
  onTimeout?: () => void;
}

export class PluginBridgeHost {
  readonly #options: PluginBridgeHostOptions;
  #port: MessagePort | null = null;
  #timer: number | null = null;
  #disposed = false;

  constructor(options: PluginBridgeHostOptions) {
    this.#options = options;
  }

  start(): void {
    window.addEventListener("message", this.#onWindowMessage);
    this.#timer = window.setTimeout(() => {
      if (this.#port !== null || this.#disposed) return;
      this.#options.onTimeout?.();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  updateTheme(theme: PluginUiTheme): void {
    this.#post({ type: "opencode-qq-ui:event", event: "theme", data: theme });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    window.removeEventListener("message", this.#onWindowMessage);
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#port?.close();
    this.#port = null;
  }

  readonly #onWindowMessage = (event: MessageEvent): void => {
    if (this.#disposed || this.#port !== null) return;
    if (event.source !== this.#options.iframe.contentWindow) return;
    const data = event.data;
    if (!isRecord(data) || data.type !== "opencode-qq-ui:ready") return;
    if (data.protocol !== PROTOCOL) return;
    if (data.nonce !== this.#options.nonce) return;
    const target = this.#options.iframe.contentWindow;
    if (target === null) return;

    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    const channel = new MessageChannel();
    this.#port = channel.port1;
    channel.port1.onmessage = (message: MessageEvent) => {
      void this.#onRequest(message.data);
    };
    channel.port1.start();
    target.postMessage(
      {
        type: "opencode-qq-ui:init",
        protocol: PROTOCOL,
        context: this.#context(),
        port: channel.port2,
      },
      "*",
      [channel.port2],
    );
    this.#options.onReady?.();
  };

  #context(): PluginUiContext {
    const { descriptor } = this.#options;
    return {
      protocol: PROTOCOL,
      pluginId: descriptor.pluginId,
      pageId: descriptor.pageId,
      title: descriptor.title,
      apiBase: `/admin/api/plugins/${encodeURIComponent(descriptor.pluginId)}`,
      locale: navigator.language,
      theme: this.#options.getTheme(),
    };
  }

  async #onRequest(data: unknown): Promise<void> {
    if (!isRecord(data) || data.type !== "opencode-qq-ui:request") return;
    const id = typeof data.id === "string" ? data.id : "";
    if (id.length === 0) return;
    const method = typeof data.method === "string" ? data.method : "";
    if (!METHODS.has(method as PluginUiMethod)) {
      this.#respondError(id, {
        code: "method_not_allowed",
        message: `不支持的插件 UI 方法：${method}`,
      });
      return;
    }
    try {
      const result = await this.#dispatch(method as PluginUiMethod, data.params);
      this.#post({ type: "opencode-qq-ui:response", id, ok: true, result });
    } catch (error) {
      this.#respondError(id, toBridgeError(error));
    }
  }

  async #dispatch(method: PluginUiMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "api.request":
        return this.#apiRequest(params);
      case "storage.get":
        return this.#storageGet(params);
      case "storage.set":
        return this.#storageSet(params);
      case "storage.remove":
        return this.#storageRemove(params);
      case "ui.toast":
        return this.#toast(params);
      case "ui.confirm":
        return this.#confirm(params);
      case "ui.openExternal":
        return this.#openExternal(params);
      case "ui.navigate":
        return this.#navigate(params);
      default:
        throw new BridgeError("method_not_allowed", `不支持的方法：${String(method)}`);
    }
  }

  async #apiRequest(params: unknown): Promise<PluginUiApiResponse> {
    if (!isRecord(params)) throw new BridgeError("invalid_request", "API 请求格式不正确。");
    const method = typeof params.method === "string" ? params.method.toUpperCase() : "";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new BridgeError("invalid_method", "HTTP 方法不支持。");
    }
    const path = typeof params.path === "string" ? params.path : "";
    if (!isPluginPath(path)) throw new BridgeError("invalid_path", "API 路径不合法。");

    const base = `/admin/api/plugins/${encodeURIComponent(this.#options.descriptor.pluginId)}`;
    const url = new URL(`${base}${path}`, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !(url.pathname === base || url.pathname.startsWith(`${base}/`))
    ) {
      throw new BridgeError("invalid_path", "API 路径超出当前插件范围。");
    }
    if (isRecord(params.query)) {
      for (const [key, value] of Object.entries(params.query)) {
        if (value === null || value === undefined) continue;
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new BridgeError("invalid_query", "查询参数必须是字符串、数字或布尔值。");
        }
        url.searchParams.set(key, String(value));
      }
    }

    const body = await requestBody(params.body);
    const relative = `${url.pathname.slice("/admin/api".length)}${url.search}`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await apiFetch(relative, {
        method,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.contentType !== undefined
          ? { headers: { "content-type": body.contentType } }
          : {}),
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
        throw new BridgeError("response_too_large", "插件 API 响应过大。");
      }
      if (response.status === 204 || response.status === 304) {
        return { status: response.status, contentType, body: { kind: "text", value: "" } };
      }
      if (contentType.includes("application/json")) {
        const text = await response.text();
        if (text.trim().length === 0) {
          return { status: response.status, contentType, body: { kind: "text", value: "" } };
        }
        try {
          return {
            status: response.status,
            contentType,
            body: { kind: "json", value: JSON.parse(text) as unknown },
          };
        } catch {
          return { status: response.status, contentType, body: { kind: "text", value: text } };
        }
      }
      if (isTextContentType(contentType)) {
        return {
          status: response.status,
          contentType,
          body: { kind: "text", value: await response.text() },
        };
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new BridgeError("response_too_large", "插件 API 响应过大。");
      }
      return { status: response.status, contentType, body: { kind: "binary", data: bytes } };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  #storageKey(key: unknown): string | null {
    return typeof key === "string" && STORAGE_KEY.test(key) ? key : null;
  }

  #storageGet(params: unknown): { value: unknown } {
    if (!isRecord(params)) throw new BridgeError("invalid_request", "storage 参数不合法。");
    const key = this.#storageKey(params.key);
    if (key === null) throw new BridgeError("invalid_storage_key", "storage key 不合法。");
    try {
      const raw = window.localStorage.getItem(this.#fullStorageKey(key));
      return { value: raw === null ? null : (JSON.parse(raw) as unknown) };
    } catch {
      throw new BridgeError("storage_failed", "读取插件本地存储失败。");
    }
  }

  #storageSet(params: unknown): { ok: true } {
    if (!isRecord(params)) throw new BridgeError("invalid_request", "storage 参数不合法。");
    const key = this.#storageKey(params.key);
    if (key === null) throw new BridgeError("invalid_storage_key", "storage key 不合法。");
    let raw: string;
    try {
      raw = JSON.stringify(params.value) ?? "null";
    } catch {
      throw new BridgeError("invalid_storage_value", "storage 值必须是可序列化的 JSON。");
    }
    if (raw.length > MAX_STORAGE_BYTES) {
      throw new BridgeError("storage_too_large", "storage 值超过 256 KiB。");
    }
    try {
      window.localStorage.setItem(this.#fullStorageKey(key), raw);
      return { ok: true };
    } catch {
      throw new BridgeError("storage_failed", "写入插件本地存储失败。");
    }
  }

  #storageRemove(params: unknown): { ok: true } {
    if (!isRecord(params)) throw new BridgeError("invalid_request", "storage 参数不合法。");
    const key = this.#storageKey(params.key);
    if (key === null) throw new BridgeError("invalid_storage_key", "storage key 不合法。");
    try {
      window.localStorage.removeItem(this.#fullStorageKey(key));
      return { ok: true };
    } catch {
      throw new BridgeError("storage_failed", "删除插件本地存储失败。");
    }
  }

  #fullStorageKey(key: string): string {
    return `opencode-qq:plugin-ui:${this.#options.descriptor.pluginId}:${key}`;
  }

  #toast(params: unknown): { ok: true } {
    if (!isRecord(params) || typeof params.message !== "string") {
      throw new BridgeError("invalid_request", "toast 参数不合法。");
    }
    if (params.message.length > 2000) {
      throw new BridgeError("invalid_request", "toast 消息过长。");
    }
    const type =
      params.type === "success" ||
      params.type === "error" ||
      params.type === "info" ||
      params.type === "warning"
        ? params.type
        : "info";
    this.#options.toast(params.message, type);
    return { ok: true };
  }

  async #confirm(params: unknown): Promise<{ confirmed: boolean }> {
    if (!isRecord(params) || typeof params.title !== "string" || params.title.length === 0) {
      throw new BridgeError("invalid_request", "confirm 参数不合法。");
    }
    if (params.title.length > 200) throw new BridgeError("invalid_request", "confirm 标题过长。");
    if (params.description !== undefined && typeof params.description !== "string") {
      throw new BridgeError("invalid_request", "confirm 描述不合法。");
    }
    const confirmed = await this.#options.confirm({
      title: params.title,
      ...(typeof params.description === "string" ? { description: params.description } : {}),
      ...(typeof params.confirmText === "string" ? { confirmText: params.confirmText } : {}),
      ...(typeof params.cancelText === "string" ? { cancelText: params.cancelText } : {}),
      ...(params.destructive === true ? { destructive: true } : {}),
    });
    return { confirmed };
  }

  #openExternal(params: unknown): { ok: boolean } {
    if (!isRecord(params) || typeof params.url !== "string") {
      throw new BridgeError("invalid_request", "openExternal 参数不合法。");
    }
    let url: URL;
    try {
      url = new URL(params.url);
    } catch {
      throw new BridgeError("invalid_url", "URL 不合法。");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BridgeError("invalid_url", "只允许打开 http/https 链接。");
    }
    const opened = window.open(url.href, "_blank", "noopener,noreferrer");
    return { ok: opened !== null };
  }

  #navigate(params: unknown): { ok: true } {
    if (!isRecord(params) || typeof params.path !== "string") {
      throw new BridgeError("invalid_request", "navigate 参数不合法。");
    }
    const path = params.path;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new BridgeError("invalid_path", "只能跳转到管理台内部路径。");
    }
    this.#options.navigate(path);
    return { ok: true };
  }

  #respondError(id: string, error: PluginUiError): void {
    this.#post({ type: "opencode-qq-ui:response", id, ok: false, error });
  }

  #post(message: unknown): void {
    this.#port?.postMessage(message);
  }
}

class BridgeError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

function toBridgeError(error: unknown): PluginUiError {
  if (error instanceof BridgeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details.length > 0 ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "timeout", message: "插件 API 请求超时。" };
  }
  return {
    code: "bridge_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isPluginPath(path: string): boolean {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "..");
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/javascript") ||
    contentType.includes("application/x-www-form-urlencoded")
  );
}

async function requestBody(value: unknown): Promise<{ body?: BodyInit; contentType?: string }> {
  if (!isRecord(value)) return {};
  if (value.kind === "json") {
    const body = JSON.stringify(value.value);
    if (body.length > MAX_REQUEST_BYTES) {
      throw new BridgeError("request_too_large", "插件 API 请求体过大。");
    }
    return { body, contentType: "application/json" };
  }
  if (value.kind === "binary" && value.data instanceof ArrayBuffer) {
    if (value.data.byteLength > MAX_REQUEST_BYTES) {
      throw new BridgeError("request_too_large", "插件 API 请求体过大。");
    }
    return {
      body: value.data,
      ...(typeof value.contentType === "string"
        ? { contentType: value.contentType }
        : { contentType: "application/octet-stream" }),
    };
  }
  if (value.kind === "form" && Array.isArray(value.entries)) {
    const form = new FormData();
    for (const entry of value.entries) {
      if (!isRecord(entry) || typeof entry.name !== "string") {
        throw new BridgeError("invalid_form", "表单字段不合法。");
      }
      if (typeof entry.value === "string") {
        form.append(entry.name, entry.value);
        continue;
      }
      if (
        isRecord(entry.value) &&
        entry.value.kind === "file" &&
        entry.value.data instanceof ArrayBuffer
      ) {
        form.append(
          entry.name,
          new File([entry.value.data], String(entry.value.name ?? "upload.bin"), {
            type: String(entry.value.type ?? "application/octet-stream"),
          }),
        );
        continue;
      }
      throw new BridgeError("invalid_form", "表单文件不合法。");
    }
    return { body: form };
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
