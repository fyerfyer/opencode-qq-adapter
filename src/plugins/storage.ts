import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginStorage } from "./sdk.js";

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Filesystem storage rooted at a plugin's data directory.
 *
 * Plugins cannot address core tables or paths outside their own directory.
 * Writes are atomic (temp file + rename) so a crash cannot truncate a file that
 * the plugin depends on.
 */
export class PluginDataStorage implements PluginStorage {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async readText(name: string): Promise<string | null> {
    try {
      return await readFile(this.#path(name), "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async writeText(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.#path(name);
    const temporary = join(
      this.dir,
      `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async readJson<T = unknown>(name: string): Promise<T | null> {
    const source = await this.readText(name);
    if (source === null) return null;
    return JSON.parse(source) as T;
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  #path(name: string): string {
    if (!SAFE_NAME.test(name) || name === "." || name === "..") {
      throw new Error(`Invalid plugin storage file name: ${name}`);
    }
    return join(this.dir, name);
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
