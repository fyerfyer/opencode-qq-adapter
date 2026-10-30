import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
import { z } from "zod";
import type { PluginConfig } from "../config/schema.js";
import {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  type PluginCapability,
  type PluginDefinition,
  type PluginManifest,
} from "./sdk.js";
import { normalizeUiRelativePath } from "./ui-path.js";

const capabilitySchema = z.enum(PLUGIN_CAPABILITIES);

const uiManifestSchema = z
  .object({
    root: z.string().min(1).max(200).optional(),
    entry: z.string().min(1).max(300).optional(),
  })
  .strict();

export const manifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/, "plugin id must be lowercase letters, digits or dashes"),
    name: z.string().min(1).max(120),
    version: z
      .string()
      .min(1)
      .refine((value) => semver.valid(value) !== null, "plugin version must be valid semver"),
    apiVersion: z.literal(PLUGIN_API_VERSION),
    description: z.string().max(500).optional(),
    capabilities: z.array(capabilitySchema).default([]),
    engines: z
      .object({
        opencodeQq: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Package-relative ESM entry; ignored by the public runtime manifest. */
    entry: z.string().min(1).optional(),
    ui: uiManifestSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ui?.root !== undefined) {
      try {
        normalizeUiRelativePath(value.ui.root, "ui.root");
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["ui", "root"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (value.ui?.entry !== undefined) {
      try {
        normalizeUiRelativePath(value.ui.entry, "ui.entry");
        if (!value.ui.entry.toLowerCase().endsWith(".html")) {
          throw new Error("ui.entry must point to an HTML file");
        }
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["ui", "entry"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

export interface PackageManifest extends PluginManifest {
  entry?: string;
}

export interface LoadedPluginModule {
  manifest: PackageManifest;
  definition: PluginDefinition<unknown>;
  entryPath: string;
  packageRoot: string | null;
}

export class PluginLoadError extends Error {
  readonly code:
    | "not_found"
    | "package_json"
    | "manifest"
    | "module"
    | "id_mismatch"
    | "incompatible";

  constructor(code: PluginLoadError["code"], message: string) {
    super(message);
    this.name = "PluginLoadError";
    this.code = code;
  }
}

export interface PackageJson {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  opencodeQq?: unknown;
}

export async function loadPluginModule(
  spec: PluginConfig,
  pluginId: string,
  coreVersion: string,
): Promise<LoadedPluginModule> {
  const target =
    spec.package !== undefined
      ? await resolvePackageTarget(spec.package)
      : await resolveLocalTarget(spec.path ?? "");

  const imported = await importModule(target.entryPath);
  const exported = imported.default ?? imported.plugin ?? imported;
  if (!isDefinition(exported)) {
    throw new PluginLoadError(
      "module",
      "plugin entry must default-export an object with a setup(context) function",
    );
  }

  const moduleManifest =
    exported.manifest === undefined
      ? null
      : parsePackageManifest(exported.manifest, `${target.entryPath}#manifest`);
  const packageManifest = target.packageJson?.opencodeQq
    ? parsePackageManifest(target.packageJson.opencodeQq, target.packageJsonPath ?? "package.json")
    : null;

  if (moduleManifest !== null && packageManifest !== null) {
    if (moduleManifest.id !== packageManifest.id) {
      throw new PluginLoadError(
        "id_mismatch",
        `manifest id '${moduleManifest.id}' does not match package.json opencodeQq.id '${packageManifest.id}'`,
      );
    }
    if (moduleManifest.version !== packageManifest.version) {
      throw new PluginLoadError(
        "id_mismatch",
        `manifest version '${moduleManifest.version}' does not match package.json opencodeQq.version '${packageManifest.version}'`,
      );
    }
  }

  const manifest = moduleManifest ?? packageManifest;
  if (manifest === null || manifest === undefined) {
    throw new PluginLoadError(
      "manifest",
      "missing plugin manifest: export `manifest` or add `opencodeQq` to package.json",
    );
  }
  if (manifest.id !== pluginId) {
    throw new PluginLoadError(
      "id_mismatch",
      `config key '${pluginId}' does not match plugin id '${manifest.id}'`,
    );
  }

  assertManifestCompatible(manifest, coreVersion);

  const capabilities = new Set<PluginCapability>(manifest.capabilities ?? []);
  return {
    manifest: { ...manifest, capabilities: [...capabilities] },
    definition: exported as PluginDefinition<unknown>,
    entryPath: target.entryPath,
    packageRoot: target.packageRoot,
  };
}

export function parsePackageManifest(value: unknown, source: string): PackageManifest {
  const declaredApiVersion = isRecord(value) ? value.apiVersion : undefined;
  if (declaredApiVersion !== undefined && declaredApiVersion !== PLUGIN_API_VERSION) {
    throw new PluginLoadError(
      "incompatible",
      `plugin API version ${String(declaredApiVersion)} is not supported in ${source}; upgrade the plugin manifest to apiVersion ${PLUGIN_API_VERSION}`,
    );
  }

  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PluginLoadError("manifest", `invalid plugin manifest in ${source}: ${details}`);
  }
  const entry = isRecord(value) && typeof value.entry === "string" ? value.entry : undefined;
  return { ...parsed.data, ...(entry !== undefined ? { entry } : {}) };
}

export function assertManifestCompatible(manifest: PackageManifest, coreVersion: string): void {
  const range = manifest.engines?.opencodeQq;
  if (range === undefined) return;
  if (semver.validRange(range) === null) {
    throw new PluginLoadError(
      "incompatible",
      `plugin ${manifest.id} declares an invalid engines.opencodeQq range: ${range}`,
    );
  }
  if (!semver.satisfies(coreVersion, range, { includePrerelease: true })) {
    throw new PluginLoadError(
      "incompatible",
      `plugin ${manifest.id} requires opencode-qq ${range}, running ${coreVersion}`,
    );
  }
}

interface ResolvedTarget {
  entryPath: string;
  packageRoot: string | null;
  packageJson: PackageJson | null;
  packageJsonPath: string | null;
}

async function resolveLocalTarget(path: string): Promise<ResolvedTarget> {
  if (path.trim().length === 0) {
    throw new PluginLoadError("not_found", "plugin path is empty");
  }
  const absolute = isAbsolute(path) ? path : resolve(path);
  const info = await stat(absolute).catch(() => null);
  if (info === null) {
    throw new PluginLoadError("not_found", `plugin path does not exist: ${absolute}`);
  }

  if (info.isFile()) {
    const packageRoot = await findPackageRoot(dirname(absolute));
    const packageJsonPath = packageRoot === null ? null : join(packageRoot, "package.json");
    return {
      entryPath: absolute,
      packageRoot,
      packageJson: packageJsonPath === null ? null : await readPackageJsonFile(packageJsonPath),
      packageJsonPath,
    };
  }
  if (!info.isDirectory()) {
    throw new PluginLoadError("not_found", `plugin path is not a file or directory: ${absolute}`);
  }

  const packageJsonPath = join(absolute, "package.json");
  const packageJson = await readPackageJsonFile(packageJsonPath);
  const manifest = packageJson?.opencodeQq
    ? parsePackageManifest(packageJson.opencodeQq, packageJsonPath)
    : null;
  const entry = await resolveEntry(absolute, packageJson, manifest?.entry);
  return {
    entryPath: entry,
    packageRoot: absolute,
    packageJson,
    packageJsonPath: packageJson === null ? null : packageJsonPath,
  };
}

async function resolvePackageTarget(specifier: string): Promise<ResolvedTarget> {
  let resolved: string;
  try {
    resolved = import.meta.resolve(specifier);
  } catch (error) {
    throw new PluginLoadError(
      "not_found",
      `cannot resolve package '${specifier}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!resolved.startsWith("file:")) {
    throw new PluginLoadError("module", `package '${specifier}' did not resolve to a file URL`);
  }
  const entryPath = fileURLToPath(resolved);
  const packageRoot = await findPackageRoot(dirname(entryPath));
  if (packageRoot === null) {
    throw new PluginLoadError(
      "package_json",
      `cannot find package.json for '${specifier}' above ${entryPath}`,
    );
  }
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = await readPackageJsonFile(packageJsonPath);
  if (packageJson === null) {
    throw new PluginLoadError("package_json", `cannot read ${packageJsonPath}`);
  }
  const manifest = packageJson.opencodeQq
    ? parsePackageManifest(packageJson.opencodeQq, packageJsonPath)
    : null;
  const entry =
    manifest?.entry !== undefined
      ? resolve(packageRoot, manifest.entry)
      : await resolveEntry(packageRoot, packageJson, undefined);
  return { entryPath: entry, packageRoot, packageJson, packageJsonPath };
}

export async function resolveEntry(
  root: string,
  packageJson: PackageJson | null,
  manifestEntry: string | undefined,
): Promise<string> {
  const candidates: string[] = [];
  if (manifestEntry !== undefined) candidates.push(manifestEntry);
  const exported = entryFromExports(packageJson?.exports);
  if (exported !== undefined) candidates.push(exported);
  if (typeof packageJson?.module === "string") candidates.push(packageJson.module);
  if (typeof packageJson?.main === "string") candidates.push(packageJson.main);
  candidates.push("src/index.ts", "src/index.js", "index.ts", "index.js", "dist/index.js");

  for (const candidate of candidates) {
    const absolute = resolve(root, candidate);
    const info = await stat(absolute).catch(() => null);
    if (info?.isFile()) return absolute;
  }
  throw new PluginLoadError(
    "module",
    `cannot determine plugin entry under ${root}; add opencodeQq.entry, exports["."] or src/index.ts`,
  );
}

function entryFromExports(exportsField: unknown): string | undefined {
  if (typeof exportsField === "string") return exportsField;
  if (!isRecord(exportsField)) return undefined;
  const dot = exportsField["."];
  if (typeof dot === "string") return dot;
  if (!isRecord(dot)) return undefined;
  for (const key of ["import", "default", "node", "types"]) {
    const value = dot[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

async function importModule(entryPath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(entryPath);
  url.searchParams.set("v", String(Date.now()));
  try {
    return (await import(url.href)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginLoadError(
      "module",
      `failed to import ${entryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readPackageJsonFile(path: string): Promise<PackageJson | null> {
  try {
    const source = await readFile(path, "utf8");
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) return null;
    return parsed as PackageJson;
  } catch {
    return null;
  }
}

async function findPackageRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  for (;;) {
    const info = await stat(join(current, "package.json")).catch(() => null);
    if (info?.isFile()) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isDefinition(value: unknown): value is PluginDefinition<unknown> {
  return isRecord(value) && typeof value.setup === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
