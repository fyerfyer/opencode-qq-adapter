import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";
import { type AppConfig, configSchema, type ProjectConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class ConfigError extends Error {
  readonly code: "read" | "yaml" | "env" | "schema" | "semantic";
  readonly details: string[];

  constructor(code: ConfigError["code"], message: string, details: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.details = details;
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Resolve and verify project directories. Enabled for `start` and `doctor`. */
  checkPaths?: boolean;
  /** Base directory used for relative paths. Defaults to the config file directory. */
  baseDir?: string;
}

export interface LoadedConfig {
  config: AppConfig;
  path: string;
  baseDir: string;
  warnings: string[];
}

export async function loadConfig(
  configPath: string,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const absolutePath = resolve(configPath);
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new ConfigError("read", `Unable to read configuration file: ${absolutePath}`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new ConfigError("yaml", `Invalid YAML in ${absolutePath}`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const missingEnv = new Set<string>();
  const expanded = expandEnv(raw, options.env ?? process.env, missingEnv, "");
  if (missingEnv.size > 0) {
    throw new ConfigError(
      "env",
      "Missing environment variables referenced by configuration",
      [...missingEnv].sort().map((name) => `\${${name}}`),
    );
  }
  const normalized = normalizeNullSections(expanded);

  const parsed = configSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ConfigError(
      "schema",
      "Configuration does not match schema",
      formatZodError(parsed.error),
    );
  }

  const baseDir = options.baseDir ? resolve(options.baseDir) : dirname(absolutePath);
  const warnings = await resolveAndValidate(parsed.data, baseDir, options.checkPaths ?? false);
  return { config: parsed.data, path: absolutePath, baseDir, warnings };
}

function expandEnv(
  value: unknown,
  env: NodeJS.ProcessEnv,
  missing: Set<string>,
  path: string,
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
      const replacement = env[name];
      if (replacement !== undefined) return replacement;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => expandEnv(item, env, missing, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandEnv(item, env, missing, `${path}.${key}`),
      ]),
    );
  }
  return value;
}

const NULLABLE_SECTIONS = new Set([
  "server",
  "onebot",
  "reconnect",
  "opencode",
  "service",
  "security",
  "rate_limit",
  "budgets",
  "users",
  "groups",
  "projects",
  "policies",
  "workspaces",
  "cleanup",
  "notifications",
  "owner_alerts",
  "logging",
  "features",
  "qq",
  "storage",
  "admin_2fa",
]);

/** `key:` with only comments in YAML parses as null; treat known sections as empty objects. */
function normalizeNullSections(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNullSections);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null && NULLABLE_SECTIONS.has(key)) {
      result[key] = {};
    } else {
      result[key] = normalizeNullSections(item);
    }
  }
  return result;
}

function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${location}: ${issue.message}`;
  });
}

async function resolveAndValidate(
  config: AppConfig,
  baseDir: string,
  checkPaths: boolean,
): Promise<string[]> {
  const warnings: string[] = [];
  const errors: string[] = [];

  config.workspaces.root = resolvePath(baseDir, config.workspaces.root);
  config.storage.database_path = resolvePath(baseDir, config.storage.database_path);
  config.storage.inbox_dir = resolvePath(baseDir, config.storage.inbox_dir);
  config.security.allowed_roots = config.security.allowed_roots.map((root) =>
    resolvePath(baseDir, root),
  );

  const projectIds = new Set(Object.keys(config.projects));
  if (projectIds.size === 0) {
    warnings.push(
      "No projects configured. Prompt handling will be unavailable until a project is added.",
    );
  }

  if (config.default_project !== null && !projectIds.has(config.default_project)) {
    errors.push(`default_project '${config.default_project}' does not exist in projects`);
  }

  for (const [id, project] of Object.entries(config.projects)) {
    project.path = resolvePath(baseDir, project.path);
    if (!isAbsolute(project.path)) {
      errors.push(`projects.${id}.path must be absolute (resolved to '${project.path}')`);
      continue;
    }
    if (config.security.allowed_roots.length > 0) {
      const inside = config.security.allowed_roots.some((root) => isPathInside(root, project.path));
      if (!inside) {
        errors.push(
          `projects.${id}.path '${project.path}' is outside security.allowed_roots (${config.security.allowed_roots.join(", ")})`,
        );
      }
    }
    if (project.agent === null && config.opencode.default_agent === null) {
      // Falling back to the OpenCode default agent is supported; this is not an error.
    }
    if (project.model !== null && !isModelRef(project.model)) {
      errors.push(
        `projects.${id}.model must look like 'provider/model' or 'provider/model#variant'`,
      );
    }
    if (checkPaths) {
      const pathError = await verifyDirectory(project.path);
      if (pathError) errors.push(`projects.${id}.path: ${pathError}`);
    }
  }

  if (config.opencode.default_model !== null && !isModelRef(config.opencode.default_model)) {
    errors.push(
      "opencode.default_model must look like 'provider/model' or 'provider/model#variant'",
    );
  }
  if (
    config.opencode.service.version !== null &&
    semver.validRange(config.opencode.service.version) === null
  ) {
    errors.push(
      `opencode.service.version is not a valid semver range: ${config.opencode.service.version}`,
    );
  }

  for (const [qq, user] of Object.entries(config.users)) {
    for (const project of user.projects) {
      if (project !== "*" && !projectIds.has(project)) {
        errors.push(`users.${qq}.projects references unknown project '${project}'`);
      }
    }
    if (user.policy !== undefined && config.policies[user.policy] === undefined) {
      errors.push(`users.${qq}.policy references unknown policy '${user.policy}'`);
    }
  }

  for (const [groupId, group] of Object.entries(config.groups)) {
    for (const project of group.projects) {
      if (project !== "*" && !projectIds.has(project)) {
        errors.push(`groups.${groupId}.projects references unknown project '${project}'`);
      }
    }
    if (group.default_project !== undefined && !projectIds.has(group.default_project)) {
      errors.push(
        `groups.${groupId}.default_project references unknown project '${group.default_project}'`,
      );
    }
    if (group.policy !== undefined && config.policies[group.policy] === undefined) {
      errors.push(`groups.${groupId}.policy references unknown policy '${group.policy}'`);
    }
    for (const member of group.allowed_users) {
      if (config.users[member] === undefined) {
        warnings.push(
          `groups.${groupId}.allowed_users includes '${member}' which is not present in users`,
        );
      }
    }
  }

  for (const [id, project] of Object.entries(config.projects)) {
    for (const user of project.allowed_users ?? []) {
      if (config.users[user] === undefined) {
        warnings.push(
          `projects.${id}.allowed_users includes '${user}' which is not present in users`,
        );
      }
    }
    for (const group of project.allowed_groups ?? []) {
      if (config.groups[group] === undefined) {
        warnings.push(
          `projects.${id}.allowed_groups includes '${group}' which is not present in groups`,
        );
      }
    }
    if (project.policy !== "" && config.policies[project.policy] === undefined) {
      warnings.push(`projects.${id}.policy '${project.policy}' is not defined in policies`);
    }
    if (project.workspace !== "shared") {
      warnings.push(
        `projects.${id}.workspace '${project.workspace}' is not implemented yet; shared mode will be used`,
      );
    }
  }

  if (config.workspaces.renew_interval_ms >= config.workspaces.lock_lease_ms) {
    errors.push("workspaces.renew_interval_ms must be smaller than workspaces.lock_lease_ms");
  }
  if (config.security.admin_2fa.enabled) {
    if (config.security.admin_2fa.totp_secret.trim().length === 0) {
      errors.push("security.admin_2fa.enabled requires security.admin_2fa.totp_secret");
    } else if (!isBase32(config.security.admin_2fa.totp_secret)) {
      errors.push("security.admin_2fa.totp_secret must be a Base32 encoded TOTP secret");
    }
  }
  if (config.onebot.access_token === "") {
    warnings.push("onebot.access_token is empty; only use this for local testing");
  }
  if (config.server.internal_token === "") {
    warnings.push("server.internal_token is empty; plugin callback endpoints are disabled");
  }
  if (config.opencode.service.mode === "external" && config.opencode.service.base_url === null) {
    // Discovery is the intended default for local OpenCode installs.
  }
  if (Object.keys(config.users).length === 0) {
    warnings.push("No users configured. Every QQ message will be ignored until users are added.");
  }

  if (errors.length > 0) {
    throw new ConfigError("semantic", "Configuration failed semantic validation", errors);
  }

  // Verify allowed roots exist once, before the bridge accepts traffic.
  if (checkPaths) {
    for (const root of config.security.allowed_roots) {
      const pathError = await verifyDirectory(root);
      if (pathError) errors.push(`security.allowed_roots: ${pathError}`);
    }
  }
  if (errors.length > 0) {
    throw new ConfigError("semantic", "Configuration failed semantic validation", errors);
  }

  return warnings;
}

function resolvePath(baseDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function verifyDirectory(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return `'${path}' is not a directory`;
    return undefined;
  } catch (error) {
    return `'${path}' is not accessible: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function isBase32(value: string): boolean {
  const normalized = value.replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase();
  return normalized.length >= 16 && /^[A-Z2-7]+$/.test(normalized);
}

function isModelRef(value: string): boolean {
  const withoutVariant = value.split("#", 1)[0] ?? value;
  const slash = withoutVariant.indexOf("/");
  return slash > 0 && slash < withoutVariant.length - 1;
}

export function projectModels(
  config: AppConfig,
  project: ProjectConfig,
): {
  agent: string | null;
  model: string | null;
} {
  return {
    agent: project.agent ?? config.opencode.default_agent,
    model: project.model ?? config.opencode.default_model,
  };
}
