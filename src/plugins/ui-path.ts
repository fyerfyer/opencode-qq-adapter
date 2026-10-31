import { extname, isAbsolute } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Normalize a package-relative UI path and reject traversal or absolute paths. */
export function normalizeUiRelativePath(value: string, label = "UI path"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.replaceAll("\\", "/").trim();
  if (normalized.startsWith("/") || isAbsolute(normalized)) {
    throw new Error(`${label} must be relative`);
  }
  if (normalized.includes("\0")) throw new Error(`${label} contains a null byte`);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, '.' or '..' segments`);
  }
  return segments.join("/");
}

export { isPathInside } from "../util/path.js";

export function pluginUiContentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function pluginUiCacheControl(relativePath: string): string {
  return relativePath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}
