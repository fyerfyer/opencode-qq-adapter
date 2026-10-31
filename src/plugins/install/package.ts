import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isPathInside } from "../../util/path.js";
import {
  assertManifestCompatible,
  type PackageManifest,
  PluginLoadError,
  parsePackageManifest,
  readPackageJsonFile,
  resolveEntry,
} from "../manifest.js";
import { PluginInstallError } from "./types.js";

export interface PackageInspection {
  manifest: PackageManifest;
  entry: string;
  packageName: string | null;
  ui: { root: string; entry: string | null } | null;
  files: number;
  bytes: number;
  warnings: string[];
}

export async function inspectPackage(
  root: string,
  input: { coreVersion: string; source: "upload" | "local"; files?: number; bytes?: number },
): Promise<PackageInspection> {
  const packageJsonPath = join(root, "package.json");
  const packageJson = await readPackageJsonFile(packageJsonPath);
  if (packageJson === null) {
    throw new PluginInstallError(400, "package_invalid", "package.json is missing or invalid");
  }
  if (packageJson.opencodeQq === undefined) {
    throw new PluginInstallError(
      400,
      "package_invalid",
      "package.json must contain opencodeQq manifest for WebUI installation",
    );
  }

  let manifest: PackageManifest;
  let entryPath: string;
  try {
    manifest = parsePackageManifest(packageJson.opencodeQq, packageJsonPath);
    assertManifestCompatible(manifest, input.coreVersion);
    entryPath = await resolveEntry(root, packageJson, manifest.entry);
  } catch (error) {
    throw toPackageError(error);
  }

  assertInside(root, entryPath, "entry");
  if (input.source === "upload" && !/\.(?:mjs|cjs|js)$/i.test(entryPath)) {
    throw new PluginInstallError(
      400,
      "package_invalid",
      "uploaded plugin entry must be built JavaScript (.js/.mjs/.cjs); use local path for TypeScript development",
    );
  }

  const warnings: string[] = [];
  if (packageJson.type !== "module" && !entryPath.toLowerCase().endsWith(".mjs")) {
    warnings.push("plugin entry is not an ESM .mjs file and package.json type is not 'module'");
  }
  if (packageJson.dependencies !== undefined && Object.keys(packageJson.dependencies).length > 0) {
    warnings.push(
      "package.json declares runtime dependencies. WebUI installation does not run npm install; bundle runtime dependencies before uploading.",
    );
  }

  const ui = await validateUi(root, manifest);
  const counts =
    input.files === undefined || input.bytes === undefined
      ? await countPackage(root)
      : { files: input.files, bytes: input.bytes };

  return {
    manifest,
    entry: relative(root, entryPath).split(sep).join("/"),
    packageName: packageJson.name ?? null,
    ui,
    files: counts.files,
    bytes: counts.bytes,
    warnings,
  };
}

async function validateUi(
  root: string,
  manifest: PackageManifest,
): Promise<PackageInspection["ui"]> {
  if (manifest.ui === undefined) return null;
  const rootPath = resolve(root, manifest.ui.root ?? "ui");
  assertInside(root, rootPath, "ui.root");
  const info = await stat(rootPath).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new PluginInstallError(400, "package_invalid", "manifest.ui.root does not exist");
  }

  const entry = manifest.ui.entry;
  if (entry === undefined) {
    return { root: manifest.ui.root ?? "ui", entry: null };
  }
  const entryPath = resolve(rootPath, entry);
  assertInside(rootPath, entryPath, "ui.entry");
  const entryInfo = await stat(entryPath).catch(() => null);
  if (entryInfo === null || !entryInfo.isFile() || !entry.toLowerCase().endsWith(".html")) {
    throw new PluginInstallError(
      400,
      "package_invalid",
      "manifest.ui.entry must be an existing HTML file",
    );
  }
  return { root: manifest.ui.root ?? "ui", entry };
}

function assertInside(root: string, target: string, label: string): void {
  if (!isPathInside(root, target, { allowRoot: false })) {
    throw new PluginInstallError(400, "package_invalid", `${label} escapes package root`);
  }
}

async function countPackage(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
      }
    }
  }
  await walk(root);
  return { files, bytes };
}

function toPackageError(error: unknown): PluginInstallError {
  if (error instanceof PluginInstallError) return error;
  if (error instanceof PluginLoadError) {
    return new PluginInstallError(400, "package_invalid", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PluginInstallError(400, "package_invalid", message);
}
