import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { ConfigError, parseConfigSource } from "../config/loader.js";
import type { ConfigReloadResult } from "../config/reload.js";
import { backupFile } from "../setup/files.js";

export class AdminConfigError extends Error {
  readonly status: 400 | 404 | 409 | 500;
  readonly code: string;
  readonly details: string[];

  constructor(
    status: AdminConfigError["status"],
    code: string,
    message: string,
    details: string[] = [],
  ) {
    super(message);
    this.name = "AdminConfigError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ConfigSnapshot {
  path: string;
  content: string;
  hash: string;
  mtime: number;
  warnings: string[];
}

export interface ConfigSaveResult extends ConfigSnapshot {
  backup: string | null;
  applied: string[];
  restartRequired: string[];
  reload: ConfigReloadResult;
}

export interface ConfigEditorOptions {
  configPath: string | null;
  reload: () => Promise<ConfigReloadResult>;
  logger: { warn: (obj: object, message: string) => void };
}

type ConfigDocument = ReturnType<typeof parseDocument>;

/**
 * Safe YAML editing for the admin UI.
 *
 * A save is always validate -> backup -> atomic rename -> hot reload. If the
 * in-memory source is invalid, the on-disk file is untouched.
 */
export class ConfigEditor {
  readonly #configPath: string | null;
  readonly #reload: () => Promise<ConfigReloadResult>;
  readonly #logger: ConfigEditorOptions["logger"];

  constructor(options: ConfigEditorOptions) {
    this.#configPath = options.configPath;
    this.#reload = options.reload;
    this.#logger = options.logger;
  }

  get enabled(): boolean {
    return this.#configPath !== null;
  }

  get path(): string | null {
    return this.#configPath;
  }

  async read(): Promise<ConfigSnapshot> {
    const path = this.#requirePath();
    let content: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    } catch (error) {
      throw new AdminConfigError(
        404,
        "config_unreadable",
        `无法读取配置文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const validated = await this.#validate(content);
    return {
      path,
      content,
      hash: sha256(content),
      mtime: info.mtimeMs,
      warnings: validated.warnings,
    };
  }

  async save(content: string, expectedHash?: string): Promise<ConfigSaveResult> {
    const path = this.#requirePath();
    const current = await readFile(path, "utf8");
    if (expectedHash !== undefined && sha256(current) !== expectedHash) {
      throw new AdminConfigError(
        409,
        "config_conflict",
        "配置文件已被其他进程修改，请刷新后重试。",
      );
    }

    const validated = await this.#validate(content);
    const backup = backupFile(path);
    await atomicWrite(path, content);
    const snapshot: ConfigSnapshot = {
      path,
      content,
      hash: sha256(content),
      mtime: (await stat(path)).mtimeMs,
      warnings: validated.warnings,
    };

    let reload: ConfigReloadResult;
    try {
      reload = await this.#reload();
    } catch (error) {
      this.#logger.warn({ err: error, path }, "Admin config save succeeded but reload failed");
      reload = {
        ok: false,
        applied: [],
        restartRequired: [],
        warnings: validated.warnings,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ...snapshot,
      backup,
      applied: reload.applied,
      restartRequired: reload.restartRequired,
      reload,
    };
  }

  /** Mutate the YAML document to preserve comments and formatting. */
  async mutate(
    mutator: (document: ConfigDocument) => void,
    expectedHash?: string,
  ): Promise<ConfigSaveResult> {
    const current = await this.read();
    if (expectedHash !== undefined && current.hash !== expectedHash) {
      throw new AdminConfigError(
        409,
        "config_conflict",
        "配置文件已被其他进程修改，请刷新后重试。",
      );
    }
    const document = parseDocument(current.content);
    if (document.errors.length > 0) {
      throw new AdminConfigError(
        400,
        "yaml",
        "配置文件 YAML 语法错误。",
        document.errors.map((error) => error.message),
      );
    }
    try {
      mutator(document);
    } catch (error) {
      throw new AdminConfigError(
        400,
        "mutation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    return this.save(document.toString(), current.hash);
  }

  async reload(): Promise<ConfigReloadResult> {
    this.#requirePath();
    return this.#reload();
  }

  async #validate(content: string): Promise<{ warnings: string[] }> {
    const path = this.#requirePath();
    try {
      const loaded = await parseConfigSource(content, path, { checkPaths: true });
      return { warnings: loaded.warnings };
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new AdminConfigError(400, error.code, error.message, error.details);
      }
      throw new AdminConfigError(
        400,
        "invalid_config",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #requirePath(): string {
    if (this.#configPath === null) {
      throw new AdminConfigError(
        409,
        "config_not_writable",
        "当前进程没有关联配置文件路径，无法编辑配置。",
      );
    }
    return this.#configPath;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const info = await stat(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: info.mode });
    await rename(temporary, path);
    await chmod(path, info.mode & 0o777).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new AdminConfigError(
      500,
      "config_write_failed",
      `写入配置文件失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
