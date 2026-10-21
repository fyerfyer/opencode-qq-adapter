import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** XDG config root, with a home-directory fallback for non-XDG shells. */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? resolve(env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
}

/** XDG data root, with a home-directory fallback for non-XDG shells. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? resolve(env.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), "opencode-qq", "config.yaml");
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), "opencode-qq");
}

export function defaultEnvPath(configPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCODE_QQ_ENV_FILE;
  if (configured && configured.length > 0) return resolve(configured);
  return join(dirname(resolve(configPath)), ".env");
}

/**
 * Resolve the config file used by CLI commands.
 *
 * Precedence is deliberate: an explicit flag wins, then an env override, then
 * the repository-local file (for `pnpm dev` compatibility), then XDG.
 */
export function resolveConfigPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (explicit && explicit.length > 0) return resolve(explicit);
  if (env.OPENCODE_QQ_CONFIG && env.OPENCODE_QQ_CONFIG.length > 0) {
    return resolve(env.OPENCODE_QQ_CONFIG);
  }
  const repoConfig = resolve(cwd, "config", "config.yaml");
  if (existsSync(repoConfig)) return repoConfig;
  return defaultConfigPath(env);
}

/** Parse a small .env file without adding a dependency. */
export function parseEnvFile(source: string): Record<string, string> {
  const values: Record<string, string> = {};
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
    values[key] = value;
  }
  return values;
}

/**
 * Load env files in order. Existing process environment wins so a systemd
 * EnvironmentFile or shell export cannot be silently overridden by a stale
 * repository `.env`.
 */
export function loadEnvFiles(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const loaded: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const values = parseEnvFile(source);
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value;
    }
    loaded.push(path);
  }
  return loaded;
}

/** Candidate env files for a command. First file wins for unset variables. */
export function envFilesForConfig(
  configPath: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const files: string[] = [];
  if (env.OPENCODE_QQ_ENV_FILE) files.push(resolve(env.OPENCODE_QQ_ENV_FILE));
  files.push(join(dirname(resolve(configPath)), ".env"));
  files.push(join(cwd, ".env"));
  return files;
}
