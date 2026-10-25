import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type MemoryDocKind = "user" | "scene";
export type MemorySection = string;

export interface MemoryDocKindConfig {
  title: string;
  sections: readonly string[];
  /** Section written only by explicit user commands; the LLM may not edit it. */
  manualSection: string;
}

export interface MemoryDocRef {
  /** Opaque namespace, e.g. a persona, project or plugin id. */
  namespace: string;
  /** Chat/scope key, e.g. `private:1` or `group:2`. */
  scope: string;
  actorQq: number;
}

export interface MemoryDoc {
  path: string;
  content: string;
  exists: boolean;
  updatedAt: number | null;
}

export interface MemoryBundle {
  shared: boolean;
  user: MemoryDoc;
  scene: MemoryDoc | null;
}

export interface MemoryOperation {
  op: "upsert" | "append" | "delete_line" | "delete_section";
  section: string;
  content?: string;
  match?: string;
  reason?: string;
}

export interface ApplyResult {
  content: string;
  changed: boolean;
  changes: string[];
}

export interface MemoryHistoryEntry {
  path: string;
  createdAt: number;
}

export interface MemoryDocPaths {
  shared: boolean;
  baseDir: string;
  historyDir: string;
  userPath: string;
  scenePath: string | null;
}

/** Domain policy for document layout, titles, sections and shared scopes. */
export interface MemoryDocumentConfig {
  user: MemoryDocKindConfig;
  scene: MemoryDocKindConfig;
  isShared(scope: string): boolean;
  paths(root: string, ref: MemoryDocRef): MemoryDocPaths;
}

export interface MemoryDocumentStoreOptions {
  root: string;
  config: MemoryDocumentConfig;
  historyLimit?: number;
  now?: () => number;
}

export interface ParsedDocument {
  title: string;
  sections: Map<string, string[]>;
  order: string[];
}

/**
 * Filesystem-backed memory documents.
 *
 * A private/per-user scope has one `memory.md`; a shared group has `scene.md`
 * plus `users/<qq>.md`. Writes are atomic, serialized per path, and keep a
 * bounded version history for rollback/audit.
 */
export class MemoryDocumentStore {
  readonly #root: string;
  readonly #config: MemoryDocumentConfig;
  readonly #historyLimit: number;
  readonly #now: () => number;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: MemoryDocumentStoreOptions) {
    this.#root = options.root;
    this.#config = options.config;
    this.#historyLimit = Math.max(1, Math.floor(options.historyLimit ?? 20));
    this.#now = options.now ?? Date.now;
  }

  isShared(scope: string): boolean {
    return this.#config.isShared(scope);
  }

  paths(ref: MemoryDocRef): MemoryDocPaths {
    return this.#config.paths(this.#root, ref);
  }

  async load(ref: MemoryDocRef): Promise<MemoryBundle> {
    const paths = this.paths(ref);
    const user = await this.#readDoc(paths.userPath);
    const scene = paths.scenePath === null ? null : await this.#readDoc(paths.scenePath);
    return { shared: paths.shared, user, scene };
  }

  async loadUser(ref: MemoryDocRef): Promise<MemoryDoc> {
    return this.#readDoc(this.paths(ref).userPath);
  }

  async loadScene(ref: MemoryDocRef): Promise<MemoryDoc | null> {
    const paths = this.paths(ref);
    return paths.scenePath === null ? null : this.#readDoc(paths.scenePath);
  }

  async loadAllUserDocs(ref: MemoryDocRef): Promise<MemoryDoc[]> {
    const paths = this.paths(ref);
    if (!paths.shared) {
      const user = await this.#readDoc(paths.userPath);
      return user.exists ? [user] : [];
    }
    const dir = join(paths.baseDir, "users");
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const docs: MemoryDoc[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      docs.push(await this.#readDoc(join(dir, entry.name)));
    }
    return docs.sort((left, right) => left.path.localeCompare(right.path));
  }

  async writeUser(ref: MemoryDocRef, content: string): Promise<MemoryDoc> {
    const paths = this.paths(ref);
    return this.#writeDoc(
      paths.userPath,
      normalizeDocument(content, "user", this.#config),
      paths.historyDir,
      `user-${ref.actorQq}`,
    );
  }

  async writeScene(ref: MemoryDocRef, content: string): Promise<MemoryDoc | null> {
    const paths = this.paths(ref);
    if (paths.scenePath === null) return null;
    return this.#writeDoc(
      paths.scenePath,
      normalizeDocument(content, "scene", this.#config),
      paths.historyDir,
      "scene",
    );
  }

  async appendManual(ref: MemoryDocRef, text: string): Promise<MemoryDoc> {
    const paths = this.paths(ref);
    const current = await this.#readDoc(paths.userPath);
    const document = parseDocument(current.content, "user", this.#config);
    const section = document.sections.get(this.#config.user.manualSection) ?? [];
    const line = `- ${text.replace(/\s+/g, " ").trim()}`;
    if (!section.includes(line)) section.push(line);
    document.sections.set(this.#config.user.manualSection, section);
    return this.#writeDoc(
      paths.userPath,
      renderDocument(document, "user", this.#config),
      paths.historyDir,
      `user-${ref.actorQq}`,
    );
  }

  async forgetSection(ref: MemoryDocRef, section: string): Promise<boolean> {
    if (section === this.#config.user.manualSection) return false;
    if (!isAllowedSection(section, "user", this.#config)) return false;
    const paths = this.paths(ref);
    const current = await this.#readDoc(paths.userPath);
    if (!current.exists) return false;
    const document = parseDocument(current.content, "user", this.#config);
    if (!document.sections.has(section)) return false;
    document.sections.delete(section);
    await this.#writeDoc(
      paths.userPath,
      renderDocument(document, "user", this.#config),
      paths.historyDir,
      `user-${ref.actorQq}`,
    );
    return true;
  }

  async forgetAll(ref: MemoryDocRef): Promise<void> {
    const paths = this.paths(ref);
    await rm(paths.baseDir, { recursive: true, force: true });
  }

  async history(ref: MemoryDocRef, kind: MemoryDocKind): Promise<MemoryHistoryEntry[]> {
    const paths = this.paths(ref);
    const prefix = kind === "scene" ? "scene-" : `user-${ref.actorQq}-`;
    const entries = await readdir(paths.historyDir, { withFileTypes: true }).catch(() => []);
    const result: MemoryHistoryEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".md")) {
        continue;
      }
      const path = join(paths.historyDir, entry.name);
      const stamp = Number(entry.name.slice(prefix.length, -3));
      result.push({ path, createdAt: Number.isFinite(stamp) ? stamp : 0 });
    }
    return result.sort((left, right) => right.createdAt - left.createdAt);
  }

  async #readDoc(path: string): Promise<MemoryDoc> {
    try {
      const content = await readFile(path, "utf8");
      return { path, content, exists: true, updatedAt: await mtime(path) };
    } catch {
      return { path, content: "", exists: false, updatedAt: null };
    }
  }

  async #writeDoc(
    path: string,
    content: string,
    historyDir: string,
    historyPrefix: string,
  ): Promise<MemoryDoc> {
    return this.#withLock(path, async () => {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await mkdir(historyDir, { recursive: true, mode: 0o700 });
      await this.#version(path, historyDir, historyPrefix);
      const temporary = join(
        dir,
        `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
      );
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
      return {
        path,
        content,
        exists: true,
        updatedAt: this.#now(),
      };
    });
  }

  async #version(path: string, historyDir: string, prefix: string): Promise<void> {
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === null || existing.trim().length === 0) return;
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
    const stamp = this.#now();
    const target = join(historyDir, `${prefix}-${stamp}.md`);
    await writeFile(target, existing, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    await this.#pruneHistory(historyDir, prefix);
  }

  async #pruneHistory(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of files.slice(this.#historyLimit)) {
      await unlink(join(dir, name)).catch(() => undefined);
    }
  }

  async #withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(path) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(path, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release?.();
      if (this.#locks.get(path) === tail) this.#locks.delete(path);
    }
  }
}

export function parseDocument(
  content: string,
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): ParsedDocument {
  const defaults = defaultSections(kind, config);
  const title = defaultTitle(kind, config);
  const sections = new Map<string, string[]>();
  const order: string[] = [];
  let parsedTitle = title;
  let current: string | null = null;

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("# ") && parsedTitle === title) {
      parsedTitle = line.slice(2).trim() || title;
      continue;
    }
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections.has(current)) {
        sections.set(current, []);
        order.push(current);
      }
      continue;
    }
    if (current !== null) {
      sections.get(current)?.push(line);
    }
  }

  for (const section of defaults) {
    if (!sections.has(section)) {
      sections.set(section, []);
      order.push(section);
    }
  }
  return { title: parsedTitle, sections, order };
}

export function renderDocument(
  document: ParsedDocument,
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): string {
  const defaults = defaultSections(kind, config);
  const ordered = [
    ...defaults.filter((section) => document.sections.has(section)),
    ...document.order.filter((section) => !defaults.includes(section)),
  ];
  const unique = [...new Set(ordered)];
  const lines: string[] = [`# ${document.title}`, ""];
  for (const section of unique) {
    lines.push(`## ${section}`);
    const body = document.sections.get(section) ?? [];
    const trimmed = trimBlankEdges(body);
    if (trimmed.length > 0) lines.push(...trimmed);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function applyOperations(
  content: string,
  operations: MemoryOperation[],
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): ApplyResult {
  const document = parseDocument(content, kind, config);
  const changes: string[] = [];
  for (const operation of operations) {
    if (!isAllowedSection(operation.section, kind, config)) continue;
    if (operation.section === config.user.manualSection) continue;
    const body = document.sections.get(operation.section) ?? [];
    if (operation.op === "upsert") {
      document.sections.set(operation.section, lines(operation.content));
      document.order.push(operation.section);
      changes.push(`replace ${operation.section}`);
    } else if (operation.op === "append") {
      document.sections.set(operation.section, [...body, ...lines(operation.content)]);
      document.order.push(operation.section);
      changes.push(`append ${operation.section}`);
    } else if (operation.op === "delete_line") {
      const match = operation.match?.trim() ?? "";
      if (match.length === 0) continue;
      const next = body.filter((line) => !line.includes(match));
      if (next.length !== body.length) {
        document.sections.set(operation.section, next);
        changes.push(`delete ${operation.section}: ${match}`);
      }
    } else if (operation.op === "delete_section") {
      if (document.sections.delete(operation.section)) {
        changes.push(`delete section ${operation.section}`);
      }
    }
  }
  const rendered = renderDocument(document, kind, config);
  return { content: rendered, changed: rendered !== content, changes };
}

export function normalizeDocument(
  content: string,
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): string {
  const document = parseDocument(content, kind, config);
  return renderDocument(document, kind, config);
}

export function docForPrompt(
  content: string,
  maxChars: number,
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): string {
  if (content.trim().length === 0 || maxChars <= 0) return "";
  const document = parseDocument(content, kind, config);
  const lines: string[] = [];
  for (const [section, body] of document.sections) {
    const trimmed = trimBlankEdges(body);
    if (trimmed.length === 0) continue;
    lines.push(`## ${section}`, ...trimmed);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function sceneForPrompt(
  content: string,
  maxChars: number,
  config: MemoryDocumentConfig,
): string {
  return docForPrompt(content, maxChars, "scene", config);
}

export function defaultTitle(kind: MemoryDocKind, config: MemoryDocumentConfig): string {
  return kind === "scene" ? config.scene.title : config.user.title;
}

export function defaultSections(
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): readonly string[] {
  return kind === "scene" ? config.scene.sections : config.user.sections;
}

export function isAllowedSection(
  section: string,
  kind: MemoryDocKind,
  config: MemoryDocumentConfig,
): boolean {
  return defaultSections(kind, config).includes(section);
}

function lines(content: string | undefined): string[] {
  if (typeof content !== "string" || content.trim().length === 0) return [];
  return content.replace(/\r\n/g, "\n").split("\n");
}

function trimBlankEdges(values: string[]): string[] {
  let start = 0;
  let end = values.length;
  while (start < end && values[start]?.trim().length === 0) start += 1;
  while (end > start && values[end - 1]?.trim().length === 0) end -= 1;
  return values.slice(start, end);
}

export function safeMemorySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
