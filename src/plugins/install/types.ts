import type { ConfigReloadResult } from "../../config/reload.js";
import type { PluginRuntimeStatus, PluginStatus } from "../host.js";

export const PLUGIN_ARCHIVE_LIMITS = {
  maxArchiveBytes: 20 * 1024 * 1024,
  maxExtractedBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxFiles: 2000,
  maxEntries: 4000,
  maxPathChars: 200,
  maxDepth: 8,
  stagingTtlMs: 60 * 60 * 1000,
  maxBackups: 3,
} as const;

export type PluginInstallErrorCode =
  | "invalid_archive"
  | "archive_too_large"
  | "archive_unsafe"
  | "archive_limit"
  | "package_invalid"
  | "package_conflict"
  | "upload_not_found"
  | "upload_expired"
  | "config_unavailable"
  | "plugin_not_found"
  | "no_backup"
  | "install_failed";

export class PluginInstallError extends Error {
  readonly code: PluginInstallErrorCode;
  readonly status: 400 | 404 | 409 | 410 | 413 | 415 | 500 | 503;
  readonly details: string[];

  constructor(
    status: PluginInstallError["status"],
    code: PluginInstallErrorCode,
    message: string,
    details: string[] = [],
  ) {
    super(message);
    this.name = "PluginInstallError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ExtractResult {
  files: number;
  bytes: number;
  root: string;
}

export interface PluginPackagePreview {
  uploadId: string | null;
  archive: { name: string; bytes: number; sha256: string } | null;
  manifest: {
    id: string;
    name: string;
    version: string;
    apiVersion: number;
    description: string | null;
    capabilities: string[];
    engines: { opencodeQq: string | null };
    ui: { root: string; entry: string | null } | null;
  };
  entry: string;
  packageName: string | null;
  files: number;
  bytes: number;
  warnings: string[];
  existing: {
    id: string;
    version: string;
    status: PluginRuntimeStatus;
    managed: boolean;
    sourceKind: "path" | "package";
  } | null;
  configHash: string | null;
  configPath: string | null;
}

export interface InstalledPluginStatus extends PluginStatus {
  managed: boolean;
}

export interface PluginInstallInfo {
  managed: boolean;
  sourceKind: "path" | "package";
  archiveName: string | null;
  archiveSha256: string | null;
  installedAt: number | null;
  previousVersion: string | null;
  backups: number;
}

export interface PluginActionResult {
  plugin: InstalledPluginStatus;
  install: PluginInstallInfo | null;
  reload: ConfigReloadResult;
  warnings: string[];
}

export interface PluginUninstallResult {
  configRemoved: boolean;
  codeRemoved: boolean;
  dataDeleted: boolean;
  reload: ConfigReloadResult;
  warnings: string[];
}
