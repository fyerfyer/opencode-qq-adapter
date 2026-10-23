import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { configHome } from "../config/paths.js";
import { backupFile } from "../setup/files.js";
import { defaultOpenCodeConfigDir } from "../setup/plugin.js";

const FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/;
const MAX_PROMPT_BYTES = 512 * 1024;

export class PromptError extends Error {
  readonly status: 400 | 404 | 409 | 500;
  readonly code: string;

  constructor(status: PromptError["status"], code: string, message: string) {
    super(message);
    this.name = "PromptError";
    this.status = status;
    this.code = code;
  }
}

export interface PromptSummary {
  name: string;
  title: string | null;
  description: string | null;
  size: number;
  updatedAt: number;
  backups: number;
}

export interface PromptFile extends PromptSummary {
  content: string;
}

export interface PromptStoreOptions {
  /** Override for tests. Defaults to `~/.config/opencode/agents`. */
  root?: string;
}

/**
 * Manages Markdown agent prompts in OpenCode's global agent directory.
 *
 * Only flat `*.md` files are exposed. Arbitrary paths, hidden files, and
 * non-Markdown files are rejected before any filesystem access.
 */
export class PromptStore {
  readonly #root: string;

  constructor(options: PromptStoreOptions = {}) {
    this.#root = options.root ?? join(defaultOpenCodeConfigDir(configHome()), "agents");
  }

  get root(): string {
    return this.#root;
  }

  async list(): Promise<PromptSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new PromptError(500, "read_failed", describe(error));
    }
    const prompts: PromptSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !FILE_PATTERN.test(entry.name)) continue;
      const summary = await this.#summary(entry.name).catch(() => null);
      if (summary !== null) prompts.push(summary);
    }
    return prompts.sort((left, right) => left.name.localeCompare(right.name));
  }

  async read(name: string): Promise<PromptFile> {
    const safeName = this.#validateName(name);
    const path = join(this.#root, safeName);
    let content: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    } catch (error) {
      if (isMissing(error)) throw new PromptError(404, "prompt_not_found", "Prompt 不存在。");
      throw new PromptError(500, "read_failed", describe(error));
    }
    const meta = parseFrontmatter(content);
    return {
      name: safeName,
      content,
      size: info.size,
      updatedAt: info.mtimeMs,
      backups: await this.#backupNames(safeName).then((files) => files.length),
      ...meta,
    };
  }

  async write(name: string, content: string): Promise<PromptFile> {
    const safeName = this.#validateName(name);
    if (Buffer.byteLength(content, "utf8") > MAX_PROMPT_BYTES) {
      throw new PromptError(400, "prompt_too_large", "Prompt 不能超过 512 KiB。");
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const path = join(this.#root, safeName);
    if (await exists(path)) backupFile(path);
    await atomicWrite(path, content);
    return this.read(safeName);
  }

  async backups(name: string): Promise<Array<{ name: string; size: number; updatedAt: number }>> {
    const safeName = this.#validateName(name);
    const files = await this.#backupNames(safeName);
    const result: Array<{ name: string; size: number; updatedAt: number }> = [];
    for (const file of files) {
      const info = await stat(join(this.#root, file)).catch(() => null);
      if (info !== null) result.push({ name: file, size: info.size, updatedAt: info.mtimeMs });
    }
    return result.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async readBackup(name: string, backup: string): Promise<string> {
    const safeName = this.#validateName(name);
    const safeBackup = this.#validateBackup(safeName, backup);
    try {
      return await readFile(join(this.#root, safeBackup), "utf8");
    } catch (error) {
      if (isMissing(error)) throw new PromptError(404, "backup_not_found", "备份不存在。");
      throw new PromptError(500, "read_failed", describe(error));
    }
  }

  async restoreBackup(name: string, backup: string): Promise<PromptFile> {
    const content = await this.readBackup(name, backup);
    return this.write(name, content);
  }

  async #summary(name: string): Promise<PromptSummary> {
    const file = await this.read(name);
    return {
      name: file.name,
      title: file.title,
      description: file.description,
      size: file.size,
      updatedAt: file.updatedAt,
      backups: file.backups,
    };
  }

  async #backupNames(name: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new PromptError(500, "read_failed", describe(error));
    }
    const prefix = `${name}.bak.`;
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  }

  #validateName(value: string): string {
    const name = basename(value);
    if (name !== value || !FILE_PATTERN.test(name)) {
      throw new PromptError(400, "invalid_prompt_name", "Prompt 文件名不合法。");
    }
    return name;
  }

  #validateBackup(name: string, backup: string): string {
    const safe = basename(backup);
    if (safe !== backup || !safe.startsWith(`${name}.bak.`)) {
      throw new PromptError(400, "invalid_backup_name", "备份文件名不合法。");
    }
    return safe;
  }
}

function parseFrontmatter(content: string): { title: string | null; description: string | null } {
  if (!content.startsWith("---")) return { title: null, description: null };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { title: null, description: null };
  const block = content.slice(3, end);
  const title = /^title:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? null;
  const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? null;
  return { title: stripQuotes(title), description: stripQuotes(description) };
}

function stripQuotes(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/^["']|["']$/g, "");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, path);
    await chmod(path, 0o644).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new PromptError(500, "write_failed", describe(error));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
