import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { parseRoleplayOptions } from "./options.js";
import { isPathInside } from "./path.js";

export interface RoleplaySetupOptions {
  configPath?: string;
  projectId?: string;
  personasDir?: string;
  pluginPath?: string;
  defaultPersona?: string | null;
  fallbackProject?: string | null;
  /** Print the resulting YAML without writing it. */
  dryRun?: boolean;
  /** Skip the timestamped config backup. */
  noBackup?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RoleplaySetupResult {
  configPath: string;
  projectId: string;
  personasDir: string;
  pluginPath: string;
  fallbackProject: string | null;
  defaultPersona: string | null;
  changed: boolean;
  warnings: string[];
}

export interface RoleplayDoctorCheck {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

export interface RoleplayDoctorResult {
  configPath: string;
  ok: boolean;
  checks: RoleplayDoctorCheck[];
}

interface RawConfig {
  [key: string]: unknown;
}

export function defaultRoleplayConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (env.OPENCODE_QQ_CONFIG && env.OPENCODE_QQ_CONFIG.length > 0) {
    return resolve(env.OPENCODE_QQ_CONFIG);
  }
  const repoConfig = resolve(cwd, "config", "config.yaml");
  if (existsSync(repoConfig)) return repoConfig;
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? resolve(env.XDG_CONFIG_HOME)
      : join(homedir(), ".config");
  return join(configHome, "opencode-qq", "config.yaml");
}

export function roleplayPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function runRoleplaySetup(
  options: RoleplaySetupOptions = {},
): Promise<RoleplaySetupResult> {
  const env = options.env ?? process.env;
  const configPath = resolve(options.configPath ?? defaultRoleplayConfigPath(env, options.cwd));
  const source = await readFile(configPath, "utf8").catch(() => null);
  if (source === null) {
    throw new Error(
      `配置文件不存在：${configPath}\n请先运行 opencode-qq setup 创建通用配置，再运行 opencode-qq-roleplay setup。`,
    );
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(
      `配置文件不是合法 YAML：${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const raw = (document.toJS() ?? {}) as RawConfig;
  const warnings: string[] = [];
  const projectId = sanitizeProjectId(options.projectId ?? existingProjectId(raw) ?? "roleplay");
  const personasDir = resolvePath(
    dirname(configPath),
    options.personasDir ?? existingPersonasDir(raw, projectId) ?? defaultPersonasDir(raw, configPath),
  );
  const pluginPath = resolvePath(
    dirname(configPath),
    options.pluginPath ?? env.OPENCODE_QQ_ROLEPLAY_PATH ?? roleplayPackageRoot(),
  );
  if (!existsSync(join(pluginPath, "package.json"))) {
    throw new Error(`Roleplay 插件目录没有 package.json：${pluginPath}`);
  }
  const fallbackProject =
    options.fallbackProject !== undefined
      ? optionalText(options.fallbackProject)
      : existingFallbackProject(raw, projectId);
  const defaultPersona =
    options.defaultPersona !== undefined
      ? optionalText(options.defaultPersona)
      : existingDefaultPersona(raw);

  await mkdir(personasDir, { recursive: true, mode: 0o700 });

  const projects = isRecord(raw.projects) ? raw.projects : {};
  const existingProject = isRecord(projects[projectId]) ? projects[projectId] : null;
  if (existingProject !== null && existingProject.managed_by !== "roleplay") {
    throw new Error(
      `projects.${projectId} 已存在且不由 Roleplay 管理；请换一个 --project ID，或手动迁移该配置。`,
    );
  }
  projects[projectId] = {
    path: personasDir,
    description: "Roleplay personas (internal)",
    workspace: "none",
    agent: typeof existingProject?.agent === "string" ? existingProject.agent : "qq-code",
    model: null,
    hidden: true,
    managed_by: "roleplay",
  };
  raw.projects = projects;

  const plugins = isRecord(raw.plugins) ? raw.plugins : {};
  const existingPlugin = isRecord(plugins.roleplay) ? plugins.roleplay : null;
  const existingOptions = isRecord(existingPlugin?.options) ? existingPlugin.options : {};
  const pluginOptions: Record<string, unknown> = {
    ...existingOptions,
    project_id: projectId,
    personas_dir: personasDir,
  };
  if (fallbackProject !== null) pluginOptions.fallback_project = fallbackProject;
  else delete pluginOptions.fallback_project;
  if (defaultPersona !== null) pluginOptions.default_persona = defaultPersona;
  parseRoleplayOptions(pluginOptions);
  plugins.roleplay = {
    enabled: true,
    path: pluginPath,
    options: pluginOptions,
  };
  raw.plugins = plugins;

  const security = isRecord(raw.security) ? raw.security : {};
  const roots = Array.isArray(security.allowed_roots)
    ? security.allowed_roots.filter((root): root is string => typeof root === "string")
    : [];
  // An empty `allowed_roots` means "no root restriction". Do not turn it into
  // a restrictive list just because Roleplay was added; only extend an
  // existing allowlist when the persona directory is outside it.
  if (
    roots.length > 0 &&
    !roots.some((item) => isPathInside(resolvePath(dirname(configPath), item), personasDir))
  ) {
    roots.push(dirname(personasDir));
  }

  document.setIn(["projects", projectId], projects[projectId]);
  document.setIn(["plugins", "roleplay"], plugins.roleplay);
  if (roots.length > 0) {
    document.setIn(["security", "allowed_roots"], roots);
  }
  const next = document.toString();
  const changed = next !== source;
  if (changed && options.dryRun !== true) {
    if (options.noBackup !== true) {
      await backupConfig(configPath, warnings);
    }
    await writeFile(configPath, next, { encoding: "utf8", mode: 0o644 });
  }

  return {
    configPath,
    projectId,
    personasDir,
    pluginPath,
    fallbackProject,
    defaultPersona,
    changed,
    warnings,
  };
}

export async function runRoleplayDoctor(
  options: { configPath?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RoleplayDoctorResult> {
  const env = options.env ?? process.env;
  const configPath = resolve(options.configPath ?? defaultRoleplayConfigPath(env, options.cwd));
  const checks: RoleplayDoctorCheck[] = [];
  const source = await readFile(configPath, "utf8").catch(() => null);
  if (source === null) {
    return {
      configPath,
      ok: false,
      checks: [
        {
          id: "config",
          ok: false,
          label: "配置文件",
          detail: `不存在：${configPath}`,
        },
      ],
    };
  }
  let raw: RawConfig;
  try {
    const document = parseDocument(source);
    if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? "invalid YAML");
    raw = (document.toJS() ?? {}) as RawConfig;
  } catch (error) {
    return {
      configPath,
      ok: false,
      checks: [
        {
          id: "config",
          ok: false,
          label: "配置文件",
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  await loadEnvFile(join(dirname(configPath), ".env"), env);
  const plugins = isRecord(raw.plugins) ? raw.plugins : {};
  const plugin = isRecord(plugins.roleplay) ? plugins.roleplay : null;
  checks.push(check("plugin", plugin !== null, "plugins.roleplay", plugin ? "已配置" : "缺少"));
  const pluginOptions = isRecord(plugin?.options) ? plugin.options : {};
  const projectId = text(pluginOptions.project_id, "roleplay");
  const projects = isRecord(raw.projects) ? raw.projects : {};
  const project = isRecord(projects[projectId]) ? projects[projectId] : null;
  checks.push(check("project", project !== null, `projects.${projectId}`, project ? "存在" : "缺少"));
  if (project !== null) {
    const projectPath = resolvePath(dirname(configPath), text(project.path, ""));
    const storage = isRecord(raw.storage) ? raw.storage : {};
    const pluginsDir = resolvePath(
      dirname(configPath),
      text(storage.plugins_dir, "var/plugins"),
    );
    const defaultPersonasDir = join(pluginsDir, "roleplay", "personas");
    const personasDir = resolvePath(
      dirname(configPath),
      text(pluginOptions.personas_dir, defaultPersonasDir),
    );
    checks.push(
      check(
        "personas_path",
        projectPath === personasDir,
        "personas_dir 与 project.path 一致",
        `${personasDir} ↔ ${projectPath}`,
      ),
    );
    checks.push(
      check("workspace", project.workspace === "none", "workspace: none", String(project.workspace)),
    );
    checks.push(check("hidden", project.hidden === true, "hidden: true", String(project.hidden)));
    checks.push(
      check(
        "managed_by",
        project.managed_by === "roleplay",
        "managed_by: roleplay",
        String(project.managed_by),
      ),
    );
    checks.push(
      check(
        "personas_exists",
        existsSync(personasDir),
        "persona 目录存在",
        personasDir,
      ),
    );
  }
  const pluginPath = text(plugin?.path, "");
  checks.push(
    check(
      "plugin_path",
      pluginPath.length > 0 && existsSync(join(resolvePath(dirname(configPath), pluginPath), "package.json")),
      "插件入口",
      pluginPath || "(未配置)",
    ),
  );
  const judge = text(pluginOptions.sticker_judge, "jev");
  const keyName = text(pluginOptions.jev_api_key_env, "TYPESAFE_API_KEY");
  if (judge === "jev" || judge === "hybrid") {
    checks.push(
      check("jev_key", (env[keyName] ?? "").trim().length > 0, "Jev API key", keyName),
    );
  }
  const opencode = isRecord(raw.opencode) ? raw.opencode : {};
  const agentId =
    (project !== null && typeof project.agent === "string" ? project.agent : null) ??
    (typeof opencode.default_agent === "string" && opencode.default_agent.length > 0
      ? opencode.default_agent
      : "qq-code");
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? resolve(env.XDG_CONFIG_HOME)
      : join(homedir(), ".config");
  const agentPath = join(configHome, "opencode", "agents", `${agentId}.md`);
  checks.push(check("agent", existsSync(agentPath), `Agent ${agentId}`, agentPath));

  return { configPath, ok: checks.every((item) => item.ok), checks };
}

function existingProjectId(raw: RawConfig): string | null {
  const plugins = isRecord(raw.plugins) ? raw.plugins : {};
  const plugin = isRecord(plugins.roleplay) ? plugins.roleplay : null;
  const options = isRecord(plugin?.options) ? plugin.options : {};
  return text(options.project_id, "") || null;
}

function existingPersonasDir(raw: RawConfig, projectId: string): string | null {
  const plugins = isRecord(raw.plugins) ? raw.plugins : {};
  const plugin = isRecord(plugins.roleplay) ? plugins.roleplay : null;
  const options = isRecord(plugin?.options) ? plugin.options : {};
  const configured = text(options.personas_dir, "");
  if (configured.length > 0) return configured;
  const projects = isRecord(raw.projects) ? raw.projects : {};
  const project = isRecord(projects[projectId]) ? projects[projectId] : null;
  const path = project === null ? "" : text(project.path, "");
  return path.length > 0 ? path : null;
}

function existingDefaultPersona(raw: RawConfig): string | null {
  const plugins = isRecord(raw.plugins) ? raw.plugins : {};
  const plugin = isRecord(plugins.roleplay) ? plugins.roleplay : null;
  const options = isRecord(plugin?.options) ? plugin.options : {};
  return optionalText(options.default_persona);
}

function existingFallbackProject(raw: RawConfig, projectId: string): string | null {
  const plugins = isRecord(raw.plugins) ? raw.plugins : {};
  const plugin = isRecord(plugins.roleplay) ? plugins.roleplay : null;
  const options = isRecord(plugin?.options) ? plugin.options : {};
  const configured = optionalText(options.fallback_project);
  if (configured !== null) return configured;
  const projects = isRecord(raw.projects) ? raw.projects : {};
  const visible = Object.entries(projects)
    .filter(([id, value]) => id !== projectId && isRecord(value) && value.hidden !== true)
    .map(([id]) => id);
  const defaultProject = typeof raw.default_project === "string" ? raw.default_project : null;
  if (defaultProject !== null && visible.includes(defaultProject)) return defaultProject;
  return visible[0] ?? null;
}

function defaultPersonasDir(raw: RawConfig, configPath: string): string {
  const storage = isRecord(raw.storage) ? raw.storage : {};
  const pluginsDir = text(storage.plugins_dir, "var/plugins");
  return join(resolvePath(dirname(configPath), pluginsDir), "roleplay", "personas");
}

async function backupConfig(configPath: string, warnings: string[]): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak.${stamp}`;
  try {
    await copyFile(configPath, backupPath);
  } catch (error) {
    warnings.push(`无法备份配置：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadEnvFile(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) return;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function check(id: string, ok: boolean, label: string, detail: string): RoleplayDoctorCheck {
  return { id, ok, label, detail };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProjectId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (id.length === 0) throw new Error("Roleplay project ID 不能为空。");
  return id;
}

function resolvePath(baseDir: string, value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}
