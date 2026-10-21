import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class SetupError extends Error {
  readonly code: "exists" | "invalid" | "write" | "docker" | "port" | "cancelled" | "unsupported";

  constructor(code: SetupError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SetupError";
    this.code = code;
  }
}

export function ensureDirectory(path: string, mode = 0o700): void {
  // Let mkdir apply the mode only to newly created directories. Chmod-ing an
  // existing config directory would unexpectedly tighten a repository folder.
  mkdirSync(path, { recursive: true, mode });
}

export function writePrivateFile(path: string, content: string): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // See ensureDirectory.
  }
}

export function writePublicFile(path: string, content: string): void {
  ensureDirectory(dirname(path));
  writeFileSync(path, content, { encoding: "utf8", mode: 0o644 });
}

export function backupFile(path: string, stamp = new Date()): string | null {
  if (!existsSync(path)) return null;
  const suffix = stamp.toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak.${suffix}`;
  copyFileSync(path, backup);
  return backup;
}

export function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readJsonIfExists<T>(path: string): T | null {
  const content = readTextIfExists(path);
  if (content === null) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sanitizeProjectId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "main";
}

export function isNumericQq(value: string): boolean {
  return /^\d{5,12}$/.test(value.trim());
}
