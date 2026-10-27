import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseEnvFile } from "../config/paths.js";
import { backupFile } from "../setup/files.js";
import { AdminError } from "./errors.js";

export interface EnvSnapshot {
  path: string;
  hash: string | null;
  values: Record<string, string>;
  exists: boolean;
}

export interface EnvUpdateResult extends EnvSnapshot {
  backup: string | null;
}

/**
 * Small, intentionally restricted editor for the bridge's private .env file.
 *
 * It preserves comments and unrelated lines, refuses values that cannot be
 * represented without escaping, writes atomically with mode 0600 and never
 * includes secret values in error messages.
 */
export class EnvEditor {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<EnvSnapshot> {
    const source = await this.#readSource();
    return this.#snapshot(source);
  }

  async update(
    updates: Record<string, string>,
    expectedHash?: string | null,
  ): Promise<EnvUpdateResult> {
    for (const [key, value] of Object.entries(updates)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new AdminError(400, "env_invalid_key", `环境变量名不合法：${key}`);
      }
      validateValue(value);
    }

    const current = await this.#readSource();
    const currentSnapshot = this.#snapshot(current);
    if (expectedHash !== undefined && (currentSnapshot.hash ?? null) !== expectedHash) {
      throw new AdminError(409, "env_conflict", "环境变量文件已被其他进程修改，请刷新后重试。");
    }

    const next = upsertEnvSource(current.source, updates);
    const backup = backupFile(this.#path);
    if (backup !== null) await chmod(backup, 0o600).catch(() => undefined);
    await writeAtomicPrivate(this.#path, next);
    const snapshot = await this.read();
    return { ...snapshot, backup };
  }

  async #readSource(): Promise<{ source: string; exists: boolean }> {
    try {
      return { source: await readFile(this.#path, "utf8"), exists: true };
    } catch (error) {
      if (isMissing(error)) return { source: "", exists: false };
      throw new AdminError(
        500,
        "env_read_failed",
        `无法读取环境变量文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #snapshot(source: { source: string; exists: boolean }): EnvSnapshot {
    return {
      path: this.#path,
      hash: source.exists ? sha256(source.source) : null,
      values: parseEnvFile(source.source),
      exists: source.exists,
    };
  }
}

function upsertEnvSource(source: string, updates: Record<string, string>): string {
  const lines = source.length === 0 ? [] : source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(line);
    if (match === null) return line;
    const key = match[2];
    if (key === undefined || !Object.hasOwn(updates, key)) return line;
    const value = updates[key];
    if (value === undefined) return line;
    seen.add(key);
    return `${match[1] ?? ""}${key}=${formatValue(value)}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) output.push(`${key}=${formatValue(value)}`);
  }
  return `${output.join("\n")}\n`;
}

function formatValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,\-?&=]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new AdminError(400, "env_invalid_value", "该值包含无法安全写入 .env 的引号或控制字符。");
}

function validateValue(value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new AdminError(400, "env_invalid_value", "环境变量值不能包含换行或空字符。");
  }
}

async function writeAtomicPrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new AdminError(
      500,
      "env_write_failed",
      `写入环境变量文件失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
