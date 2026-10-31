import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { safeMemorySegment } from "@opencode-qq/memory";
import type { PluginAdminRequestContext } from "@opencode-qq/plugin-sdk";
import {
  MANUAL_SECTION,
  type MemoryDoc,
  type MemoryDocKind,
  parseDocument,
  SCENE_SECTIONS,
  USER_SECTIONS,
} from "../memory-document.js";
import { isPathInside } from "../path.js";
import { AdminHttpError } from "./http.js";
import { requirePersona } from "./persona-access.js";
import type { RoleplayAdminDeps } from "./types.js";
import { MEMORY_SCOPE } from "./validation.js";

export interface MemoryScope {
  scope: string;
  chatKey: string | null;
  kind: "private" | "shared";
  label: string;
  actorQq: number | null;
  docs: Array<{
    kind: MemoryDocKind;
    actorQq: number | null;
    name: string;
    exists: boolean;
    size: number;
    updatedAt: number | null;
  }>;
}

export interface MemoryJob {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
  error: string | null;
}

export async function listMemoryScopes(
  deps: RoleplayAdminDeps,
  personaId: string,
): Promise<MemoryScope[]> {
  const root = join(deps.memoryRoot, personaId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const bindings = deps.bindings.list();
  const result: MemoryScope[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !MEMORY_SCOPE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    const scenePath = join(dir, "scene.md");
    const userPath = join(dir, "memory.md");
    const scene = await fileStat(scenePath);
    const user = await fileStat(userPath);
    if (scene === null && user === null) continue;
    const binding = bindings.find((item) => safeMemorySegment(item.chatKey) === entry.name);
    const actorQq = parseActorFromScope(entry.name);
    const shared = scene !== null;
    const docs: MemoryScope["docs"] = [];
    if (shared) {
      docs.push(memoryDocInfo("scene", null, scenePath, scene));
      const users = await readdir(join(dir, "users"), { withFileTypes: true }).catch(() => []);
      for (const file of users) {
        if (!file.isFile() || !/^\d{5,12}\.md$/.test(file.name)) continue;
        const path = join(dir, "users", file.name);
        const info = await fileStat(path);
        if (info !== null) {
          docs.push(memoryDocInfo("user", Number(file.name.slice(0, -3)), path, info));
        }
      }
    } else if (user !== null) {
      docs.push(memoryDocInfo("user", actorQq, userPath, user));
    }
    result.push({
      scope: entry.name,
      chatKey: binding?.chatKey ?? null,
      kind: shared ? "shared" : "private",
      label: scopeLabel(binding?.chatKey ?? null, entry.name),
      actorQq,
      docs,
    });
  }
  return result.sort((left, right) => left.scope.localeCompare(right.scope));
}

function memoryDocInfo(
  kind: MemoryDocKind,
  actorQq: number | null,
  path: string,
  info: { size: number; mtimeMs: number },
) {
  return {
    kind,
    actorQq,
    name: basename(path),
    exists: true,
    size: info.size,
    updatedAt: info.mtimeMs,
  };
}

export async function memoryTarget(
  deps: RoleplayAdminDeps,
  context: PluginAdminRequestContext,
) {
  const personaId = context.query.get("persona") ?? "";
  const scope = context.query.get("scope") ?? "";
  const kind = context.query.get("kind") === "scene" ? "scene" : "user";
  const actorQq = Number(context.query.get("actorQq") ?? parseActorFromScope(scope) ?? 0);
  if (!MEMORY_SCOPE.test(scope)) throw new AdminHttpError(400, "invalid_scope", "scope 不合法。");
  if (!Number.isSafeInteger(actorQq) || actorQq < 0) {
    throw new AdminHttpError(400, "invalid_actor", "actorQq 不合法。");
  }
  const persona = await requirePersona(deps, personaId);
  return { persona, ref: { scope }, kind, actorQq } as const;
}

export async function readMemoryDoc(
  deps: RoleplayAdminDeps,
  personaId: string,
  scope: string,
  kind: MemoryDocKind,
  actorQq: number,
) {
  const ref = { namespace: personaId, scope, actorQq };
  const bundle = await deps.documents.load(ref);
  const doc = kind === "scene" ? bundle.scene : bundle.user;
  if (doc === null) {
    throw new AdminHttpError(400, "invalid_scope", "私有 scope 没有 scene 文档。");
  }
  return memoryDoc(doc, kind);
}

export async function writeMemoryDoc(
  deps: RoleplayAdminDeps,
  input: {
    personaId: string;
    scope: string;
    actorQq: number;
    kind: MemoryDocKind;
    content: string;
    allowManual: boolean;
  },
) {
  if (!MEMORY_SCOPE.test(input.scope)) {
    throw new AdminHttpError(400, "invalid_scope", "scope 不合法。");
  }
  const ref = {
    namespace: input.personaId,
    scope: input.scope,
    actorQq: input.actorQq,
  };
  const bundle = await deps.documents.load(ref);
  const current = input.kind === "scene" ? bundle.scene : bundle.user;
  if (input.kind === "scene" && current === null) {
    throw new AdminHttpError(400, "invalid_scope", "该 scope 不是群聊 scope。");
  }
  const parsed = parseDocument(input.content, input.kind);
  const allowed: readonly string[] = input.kind === "user" ? USER_SECTIONS : SCENE_SECTIONS;
  for (const section of parsed.sections.keys()) {
    if (!allowed.includes(section)) {
      throw new AdminHttpError(400, "invalid_section", `不允许的 section：${section}`);
    }
  }
  const beforeManual =
    current === null
      ? []
      : (parseDocument(current.content, input.kind).sections.get(MANUAL_SECTION) ?? []);
  const afterManual = parsed.sections.get(MANUAL_SECTION) ?? [];
  if (!input.allowManual && beforeManual.join("\n") !== afterManual.join("\n")) {
    throw new AdminHttpError(
      409,
      "manual_section_locked",
      "手动记忆 section 只能通过 !remember 或显式允许手动编辑来修改。",
    );
  }
  const saved =
    input.kind === "scene"
      ? await deps.documents.writeScene(ref, input.content)
      : await deps.documents.writeUser(ref, input.content);
  if (saved === null) throw new AdminHttpError(400, "invalid_scope", "保存记忆失败。");
  return memoryDoc(saved, input.kind);
}

function memoryDoc(doc: MemoryDoc, kind: MemoryDocKind) {
  const parsed = parseDocument(doc.content, kind);
  return {
    ...doc,
    kind,
    manualSection: MANUAL_SECTION,
    sections: [...parsed.sections.keys()],
  };
}

export async function memoryHistory(
  deps: RoleplayAdminDeps,
  personaId: string,
  scope: string,
  kind: MemoryDocKind,
  actorQq: number,
) {
  const entries = await deps.documents.history({ namespace: personaId, scope, actorQq }, kind);
  return entries.map((entry) => ({
    name: basename(entry.path),
    path: entry.path,
    createdAt: entry.createdAt,
  }));
}

export async function readMemoryHistory(
  deps: RoleplayAdminDeps,
  path: string,
): Promise<string> {
  const root = deps.memoryRoot;
  const resolved = await realpath(path).catch(() => path);
  if (!isPathInside(root, resolved, { allowRoot: false })) {
    throw new AdminHttpError(400, "invalid_history", "历史文件路径不合法。");
  }
  const historyPath = relative(root, resolved);
  if (!resolved.endsWith(".md") || !historyPath.includes(`${sep}history${sep}`)) {
    throw new AdminHttpError(400, "invalid_history", "历史文件路径不合法。");
  }
  return readFile(resolved, "utf8");
}

export function parseActorFromScope(scope: string): number | null {
  const match = /^private_(\d{5,12})$/.exec(scope);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function scopeLabel(chatKey: string | null, scope: string): string {
  if (chatKey?.startsWith("private:")) return `私聊 ${chatKey.slice("private:".length)}`;
  if (chatKey?.startsWith("group:")) {
    const groupId = chatKey.split(":")[1];
    return `群 ${groupId ?? ""}`;
  }
  return scope;
}

async function fileStat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}
