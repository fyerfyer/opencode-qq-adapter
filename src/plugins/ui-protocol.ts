/**
 * Wire protocol shared by the core admin WebUI and `@opencode-qq/plugin-ui`.
 *
 * This module is intentionally free of DOM and Node imports so the same types
 * can be published to third-party plugin frontends.
 */

export const PLUGIN_UI_PROTOCOL_VERSION = 1 as const;

export type PluginUiThemeMode = "light" | "dark";

export interface PluginUiTheme {
  mode: PluginUiThemeMode;
  /** Core CSS custom properties (background, foreground, border, radius, ...). */
  tokens: Record<string, string>;
}

export interface PluginUiContext {
  protocol: typeof PLUGIN_UI_PROTOCOL_VERSION;
  pluginId: string;
  pageId: string;
  title: string;
  /** `/admin/api/plugins/<plugin-id>`; kept for diagnostics only. */
  apiBase: string;
  locale: string;
  theme: PluginUiTheme;
}

export type PluginUiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginUiFormFile {
  kind: "file";
  name: string;
  type: string;
  data: ArrayBuffer;
}

export interface PluginUiFormEntry {
  name: string;
  value: string | PluginUiFormFile;
}

export type PluginUiRequestBody =
  | { kind: "json"; value: unknown }
  | { kind: "form"; entries: PluginUiFormEntry[] }
  | { kind: "binary"; data: ArrayBuffer; contentType?: string };

export interface PluginUiApiRequest {
  method: PluginUiHttpMethod;
  /** Path after `/admin/api/plugins/<plugin-id>`, always starts with `/`. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: PluginUiRequestBody;
  timeoutMs?: number;
}

export type PluginUiResponseBody =
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string }
  | { kind: "binary"; data: ArrayBuffer };

export interface PluginUiApiResponse {
  status: number;
  contentType: string;
  body: PluginUiResponseBody;
}

export interface PluginUiError {
  code: string;
  message: string;
  details?: string[];
  status?: number;
}

export interface PluginUiToastParams {
  message: string;
  type?: "success" | "error" | "info" | "warning";
}

export interface PluginUiConfirmParams {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

export interface PluginUiNavigateParams {
  /** Core WebUI route, for example `/agents?name=qq-code.md`. */
  path: string;
}

export interface PluginUiStorageGetParams {
  key: string;
}

export interface PluginUiStorageSetParams {
  key: string;
  value: unknown;
}

export interface PluginUiStorageRemoveParams {
  key: string;
}

export interface PluginUiOpenExternalParams {
  url: string;
}

export interface PluginUiMethodMap {
  "api.request": { params: PluginUiApiRequest; result: PluginUiApiResponse };
  "storage.get": { params: PluginUiStorageGetParams; result: { value: unknown } };
  "storage.set": { params: PluginUiStorageSetParams; result: { ok: true } };
  "storage.remove": { params: PluginUiStorageRemoveParams; result: { ok: true } };
  "ui.toast": { params: PluginUiToastParams; result: { ok: true } };
  "ui.confirm": { params: PluginUiConfirmParams; result: { confirmed: boolean } };
  "ui.openExternal": { params: PluginUiOpenExternalParams; result: { ok: boolean } };
  "ui.navigate": { params: PluginUiNavigateParams; result: { ok: true } };
}

export type PluginUiMethod = keyof PluginUiMethodMap;

export type PluginUiMethodParams<M extends PluginUiMethod> = PluginUiMethodMap[M]["params"];
export type PluginUiMethodResult<M extends PluginUiMethod> = PluginUiMethodMap[M]["result"];

export interface PluginUiReadyMessage {
  type: "opencode-qq-ui:ready";
  protocol: number;
  nonce: string;
}

export interface PluginUiInitMessage {
  type: "opencode-qq-ui:init";
  protocol: typeof PLUGIN_UI_PROTOCOL_VERSION;
  context: PluginUiContext;
  /** MessagePort transferred by the host. */
  port: unknown;
}

export interface PluginUiRequestMessage {
  type: "opencode-qq-ui:request";
  id: string;
  method: PluginUiMethod;
  params: unknown;
}

export interface PluginUiResponseMessage {
  type: "opencode-qq-ui:response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: PluginUiError;
}

export interface PluginUiThemeEvent {
  type: "opencode-qq-ui:event";
  event: "theme";
  data: PluginUiTheme;
}

export interface PluginUiNavigateEvent {
  type: "opencode-qq-ui:event";
  event: "navigate";
  data: PluginUiNavigateParams;
}

export type PluginUiHostEvent = PluginUiThemeEvent | PluginUiNavigateEvent;

export type PluginUiFrameMessage = PluginUiReadyMessage | PluginUiRequestMessage;
export type PluginUiHostMessage = PluginUiInitMessage | PluginUiResponseMessage | PluginUiHostEvent;

export const PLUGIN_UI_METHODS: readonly PluginUiMethod[] = [
  "api.request",
  "storage.get",
  "storage.set",
  "storage.remove",
  "ui.toast",
  "ui.confirm",
  "ui.openExternal",
  "ui.navigate",
];

export function isPluginUiMethod(value: unknown): value is PluginUiMethod {
  return typeof value === "string" && (PLUGIN_UI_METHODS as readonly string[]).includes(value);
}
