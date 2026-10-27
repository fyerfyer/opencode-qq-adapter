import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  PluginAdminActor,
  PluginAdminMethod,
  PluginAdminPage,
  PluginAdminResult,
  PluginManifest,
} from "../sdk.js";
import {
  isPathInside,
  normalizeUiRelativePath,
  pluginUiCacheControl,
  pluginUiContentType,
} from "../ui-path.js";
import { isRecord, withTimeout } from "./convert.js";
import type {
  AdminPathSegment,
  PluginInstance,
  PluginUiAssetInfo,
  PluginUiPageInfo,
  RegisteredAdminRoute,
} from "./types.js";

const ADMIN_TIMEOUT_MS = 120_000;

export function normalizeAdminMethod(method: PluginAdminMethod): PluginAdminMethod {
  const normalized = String(method).toUpperCase();
  if (
    normalized !== "GET" &&
    normalized !== "POST" &&
    normalized !== "PUT" &&
    normalized !== "PATCH" &&
    normalized !== "DELETE"
  ) {
    throw new Error(`unsupported admin method: ${String(method)}`);
  }
  return normalized;
}

export function normalizeAdminPath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("admin route path must be a non-empty string");
  }
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`admin route path must not contain '.' or '..': ${path}`);
  }
  return normalized;
}

export function compileAdminPath(path: string): AdminPathSegment[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment): AdminPathSegment => {
      if (segment === "*") return { kind: "wildcard" };
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
          throw new Error(`invalid admin route parameter: ${segment}`);
        }
        return { kind: "param", name };
      }
      if (segment.includes(":") || segment.includes("*")) {
        throw new Error(`admin route parameters must occupy a full segment: ${segment}`);
      }
      return { kind: "static", value: segment };
    });
}

export function normalizeAdminPage(
  page: PluginAdminPage,
  pluginId: string,
  manifest: PluginManifest,
): PluginAdminPage {
  if (!isRecord(page)) throw new Error("admin page must be an object");
  const id = typeof page.id === "string" ? page.id.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("admin page id must be lowercase letters, digits or dashes");
  }
  const title = typeof page.title === "string" ? page.title.trim() : "";
  if (title.length === 0 || title.length > 120) {
    throw new Error("admin page title must be 1-120 characters");
  }
  const kind = page.kind ?? "native";
  if (kind !== "native" && kind !== "iframe") {
    throw new Error("admin page kind must be 'native' or 'iframe'");
  }
  const description =
    typeof page.description === "string" && page.description.trim().length > 0
      ? page.description.trim().slice(0, 500)
      : undefined;

  if (kind === "iframe") {
    if (manifest.ui === undefined && page.entry === undefined) {
      throw new Error(`iframe admin page '${id}' requires manifest.ui or a page entry`);
    }
    const entry = page.entry ?? manifest.ui?.entry;
    if (entry === undefined) {
      throw new Error(`iframe admin page '${id}' requires an HTML entry`);
    }
    let normalizedEntry: string;
    try {
      normalizedEntry = normalizeUiRelativePath(entry, "page entry");
    } catch (error) {
      throw new Error(
        `invalid entry for iframe admin page '${id}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!normalizedEntry.toLowerCase().endsWith(".html")) {
      throw new Error(`iframe admin page '${id}' entry must point to an HTML file`);
    }
    return {
      id,
      title,
      path: `/plugins/${pluginId}/${id}`,
      kind,
      entry: normalizedEntry,
      ...(description !== undefined ? { description } : {}),
    };
  }

  if (page.path === undefined) {
    throw new Error(`native admin page '${id}' requires a path`);
  }
  const path = normalizeAdminPath(page.path);
  if (path === "/admin" || path.startsWith("/admin/")) {
    throw new Error("admin page path must be a core UI route outside /admin");
  }
  return {
    id,
    title,
    path,
    kind,
    ...(description !== undefined ? { description } : {}),
  };
}

export function resolveAdminUiPage(
  instance: PluginInstance,
  pageId?: string,
): PluginUiPageInfo | null {
  if (instance.status !== "loaded") return null;
  const manifest = instance.manifest;
  if (manifest === null || instance.packageRoot === null) return null;
  const pages = instance.adminPages.filter((page) => page.kind === "iframe");
  const page = pageId === undefined ? pages[0] : pages.find((item) => item.id === pageId);
  if (page === undefined) return null;
  const entry = page.entry ?? manifest.ui?.entry;
  if (entry === undefined) return null;
  let normalizedEntry: string;
  try {
    normalizedEntry = normalizeUiRelativePath(entry, "page entry");
  } catch {
    return null;
  }
  const rootName = manifest.ui?.root ?? "ui";
  let root: string;
  try {
    root = resolve(instance.packageRoot, normalizeUiRelativePath(rootName, "ui.root"));
  } catch {
    return null;
  }
  return { page, entry: normalizedEntry, root };
}

/** Resolve a static UI asset, following symlinks only when they stay in root. */
export async function resolveAdminUiAsset(
  instance: PluginInstance,
  assetPath: string,
): Promise<PluginUiAssetInfo | null> {
  if (instance.status !== "loaded" || instance.packageRoot === null) return null;
  let relativePath: string;
  try {
    relativePath = normalizeUiRelativePath(assetPath, "UI asset path");
  } catch {
    return null;
  }
  const rootName = instance.manifest?.ui?.root ?? "ui";
  let root: string;
  try {
    root = resolve(instance.packageRoot, normalizeUiRelativePath(rootName, "ui.root"));
  } catch {
    return null;
  }
  const rootReal = await realpath(root).catch(() => null);
  if (rootReal === null) return null;
  const candidate = resolve(root, relativePath);
  if (!isPathInside(root, candidate)) return null;
  const info = await stat(candidate).catch(() => null);
  if (info === null || !info.isFile()) return null;
  const real = await realpath(candidate).catch(() => null);
  if (real === null || !isPathInside(rootReal, real)) return null;
  return {
    path: real,
    contentType: pluginUiContentType(relativePath),
    cacheControl: pluginUiCacheControl(relativePath),
  };
}

/** Select and invoke the most specific admin route for an authenticated request. */
export async function dispatchAdminRoute(
  instance: PluginInstance,
  request: Request,
  path: string,
  actor: PluginAdminActor,
): Promise<PluginAdminResult | null> {
  const method = request.method.toUpperCase() as PluginAdminMethod;
  const normalized = normalizeAdminPath(path);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const candidates = instance.adminRoutes
    .filter((route) => route.method === method)
    .map((route) => ({ route, params: matchAdminPath(route.segments, segments) }))
    .filter(
      (item): item is { route: RegisteredAdminRoute; params: Record<string, string> } =>
        item.params !== null,
    )
    .sort(
      (left, right) =>
        adminSpecificity(right.route) - adminSpecificity(left.route) ||
        left.route.order - right.route.order,
    );
  const selected = candidates[0];
  if (selected === undefined) return null;

  const query = new URL(request.url).searchParams;
  return withTimeout(
    Promise.resolve(
      selected.route.handler({
        request,
        method,
        path: normalized,
        params: selected.params,
        query,
        actor,
      }),
    ),
    ADMIN_TIMEOUT_MS,
    `admin route ${method} ${selected.route.pattern} of ${instance.id}`,
  );
}

function matchAdminPath(
  pattern: AdminPathSegment[],
  segments: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  let index = 0;
  for (const part of pattern) {
    if (part.kind === "wildcard") {
      const rest = segments.slice(index);
      if (rest.length === 0) return null;
      params["*"] = rest.map(decodeAdminSegment).join("/");
      return params;
    }
    const value = segments[index];
    if (value === undefined) return null;
    if (part.kind === "static") {
      if (value !== part.value) return null;
    } else {
      const decoded = decodeAdminSegment(value);
      if (decoded.length === 0 || decoded.includes("/")) return null;
      params[part.name] = decoded;
    }
    index += 1;
  }
  return index === segments.length ? params : null;
}

function decodeAdminSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function adminSpecificity(route: RegisteredAdminRoute): number {
  let score = 0;
  for (const segment of route.segments) {
    if (segment.kind === "static") score += 100;
    else if (segment.kind === "param") score += 10;
  }
  return score + route.segments.length;
}
