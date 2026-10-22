import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import semver from "semver";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../config/loader.js";
import {
  configHome as defaultConfigHome,
  defaultDataDir,
  resolveConfigPath,
} from "../config/paths.js";
import {
  backupFile,
  ensureDirectory,
  isNumericQq,
  randomToken,
  readTextIfExists,
  SetupError,
  sanitizeProjectId,
  writePrivateFile,
  writePublicFile,
} from "./files.js";
import {
  type CommandRunner,
  defaultRunner,
  detectComposeCommand,
  isPortAvailable,
  type NapCatDockerResult,
  setupNapCatDocker,
} from "./napcat-docker.js";
import { defaultOpenCodeConfigDir, installOpenCodePlugin } from "./plugin.js";
import { createPrompt, type Prompt } from "./prompt.js";

export type NapCatMode = "docker" | "existing" | "skip";

export interface SetupProject {
  id: string;
  path: string;
}

export interface SetupOptions {
  configPath?: string;
  dataDir?: string;
  ownerQq?: string;
  projects?: SetupProject[];
  napcat?: NapCatMode;
  napcatUrl?: string;
  napcatToken?: string;
  webuiPort?: number;
  wsPort?: number;
  yes?: boolean;
  force?: boolean;
  skipPlugin?: boolean;
  skipDoctor?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  portAvailable?: (port: number) => Promise<boolean>;
  output?: (line: string) => void;
}

export interface SetupResult {
  configPath: string;
  envPath: string;
  dataDir: string;
  ownerQq: string;
  projects: SetupProject[];
  napcatMode: NapCatMode;
  napcatStarted: boolean;
  napcatUrl: string;
  napcatAccessToken: string;
  webuiUrl: string | null;
  webuiToken: string | null;
  pluginPath: string | null;
  bridgeConfigPath: string | null;
  warnings: string[];
}

/**
 * Generate a complete, safe default config rather than copying the example
 * file. The example intentionally contains placeholders (`10001`, `..`), which
 * are a poor first-run experience because unauthorized messages are ignored.
 */
function envRef(name: string, fallback?: string): string {
  // Keep this as a literal ${NAME} placeholder for the config loader.
  // biome-ignore lint/style/useTemplate: string concatenation avoids treating the placeholder as interpolation
  return "$" + "{" + name + (fallback === undefined ? "" : `:-${fallback}`) + "}";
}

export function generateConfigObject(options: {
  ownerQq: string;
  projects: SetupProject[];
  dataDir: string;
}): Record<string, unknown> {
  const projectPaths = [...new Set(options.projects.map((project) => resolve(project.path)))];
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 8787,
      health_path: "/health",
      internal_token: envRef("QQ_BRIDGE_INTERNAL_TOKEN"),
    },
    onebot: {
      url: envRef("NAPCAT_WS_URL", "ws://127.0.0.1:3001"),
      access_token: envRef("NAPCAT_ACCESS_TOKEN", ""),
      action_timeout_ms: 15000,
      upload_timeout_ms: 600000,
      login_probe_ms: 60000,
      dedupe_ttl_ms: 600000,
      reconnect: { enabled: true, attempts: 1000000, delay_ms: 3000 },
    },
    opencode: {
      service: {
        mode: "external",
        base_url: null,
        version: ">=2.0.0 <3.0.0",
        command: ["opencode", "serve", "--service"],
        manage_lifecycle: false,
      },
      default_agent: null,
      default_model: null,
      prompt_timeout_ms: 1800000,
      permission_timeout_ms: 120000,
      event_reconnect_ms: 2000,
      event_reconnect_max_ms: 30000,
      health_cache_ms: 5000,
    },
    security: {
      default_effect: "deny",
      allowed_roots: projectPaths,
      require_mention_in_group: true,
      max_prompt_chars: 8000,
      max_images_per_message: 4,
      max_image_bytes: 10485760,
      max_outbound_image_bytes: 20971520,
      max_queued_prompts: 3,
      rate_limit: { prompts_per_minute: 6, runs_per_hour: 30 },
      budgets: {
        daily_cost_usd_per_user: 5,
        daily_tokens_per_user: 2000000,
        daily_cost_usd_per_project: 20,
      },
      admin_2fa: { enabled: false, totp_secret: "", window_seconds: 300 },
    },
    default_project: options.projects[0]?.id ?? null,
    users: {
      [options.ownerQq]: { role: "owner", projects: ["*"] },
    },
    groups: {},
    projects: Object.fromEntries(
      options.projects.map((project) => [
        project.id,
        {
          path: resolve(project.path),
          description: project.id,
          policy: "standard",
          workspace: "shared",
          agent: null,
          model: null,
          allowed_users: [options.ownerQq],
          setup: [],
        },
      ]),
    ),
    policies: {
      readonly: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: "deny",
        shell: "deny",
        webfetch: "ask",
        websearch: "ask",
        external_directory: "deny",
      },
      standard: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: "ask",
        shell: "ask",
        webfetch: "ask",
        websearch: "ask",
        external_directory: "deny",
        shell_rules: [
          { pattern: "git status *", effect: "allow" },
          { pattern: "git diff *", effect: "allow" },
          { pattern: "git push *", effect: "deny" },
          { pattern: "rm -rf *", effect: "deny" },
        ],
      },
      trusted: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: "allow",
        shell: "allow",
        webfetch: "allow",
        websearch: "allow",
        external_directory: "deny",
        shell_rules: [
          { pattern: "sudo *", effect: "deny" },
          { pattern: "git push *", effect: "ask" },
        ],
      },
    },
    workspaces: {
      default_mode: "shared",
      root: join(options.dataDir, "workspaces"),
      idle_ttl_hours: 72,
      max_per_project: 5,
      lock_lease_ms: 120000,
      renew_interval_ms: 30000,
      cleanup: { require_clean: true, keep_dirty_days: 7 },
    },
    notifications: {
      owner_alerts: {
        enabled: true,
        on_startup: false,
        on_run_failure: true,
        on_budget_exceeded: true,
      },
    },
    logging: {
      level: "info",
      audit_retention_days: 90,
      store_prompt_content: false,
      redact: ["NAPCAT_ACCESS_TOKEN", "QQ_BRIDGE_INTERNAL_TOKEN", "OPENCODE_SERVER_PASSWORD"],
    },
    features: { images: true, files: false, worktrees: false, forms: false, metrics: false },
    qq: {
      max_message_chars: 1800,
      strip_markdown: true,
      reply_to_message: true,
      mention_sender_in_group: true,
      progress_ack: true,
      progress_delay_ms: 3000,
    },
    storage: {
      database_path: join(options.dataDir, "opencode-qq.db"),
      inbox_dir: join(options.dataDir, "inbox"),
      inbox_ttl_hours: 24,
    },
  };
}

export function renderConfigYaml(options: {
  ownerQq: string;
  projects: SetupProject[];
  dataDir: string;
}): string {
  const header = [
    "# Generated by `opencode-qq setup`.",
    "# Secrets live in .env next to this file; never commit it.",
    "",
  ].join("\n");
  return `${header}${stringifyYaml(generateConfigObject(options))}`;
}

export function renderEnvFile(options: {
  wsUrl: string;
  accessToken: string;
  bridgeToken: string;
}): string {
  return [
    "# Generated by `opencode-qq setup`. Keep this file mode 0600.",
    `NAPCAT_WS_URL=${options.wsUrl}`,
    `NAPCAT_ACCESS_TOKEN=${options.accessToken}`,
    `QQ_BRIDGE_INTERNAL_TOKEN=${options.bridgeToken}`,
    "",
  ].join("\n");
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(options.configPath ?? resolveConfigPath(undefined, env));
  const dataDir = resolve(options.dataDir ?? defaultDataDir(env));
  const output = options.output ?? ((line: string) => console.log(line));
  const warnings: string[] = [];
  const interactive = options.yes !== true && Boolean(process.stdin.isTTY);
  const prompt = interactive ? createPrompt() : null;

  try {
    output("");
    output("OpenCode QQ Adapter setup");
    output("==========================");
    output("");
    output(`Config file: ${configPath}`);
    output(`Data directory: ${dataDir}`);
    output("");

    if (existsSync(configPath) && options.force !== true) {
      throw new SetupError(
        "exists",
        `Configuration already exists: ${configPath}\nUse --force to back it up and regenerate.`,
      );
    }

    output("[1/7] Checking runtime...");
    if (!semver.satisfies(process.versions.node, ">=22.18.0")) {
      throw new SetupError(
        "unsupported",
        `Node.js 22.18+ is required; current version is ${process.versions.node}.`,
      );
    }
    output(`      Node.js ${process.versions.node}`);
    try {
      const result = await (options.runner ?? defaultRunner).run("opencode", ["--version"], {
        timeoutMs: 5000,
      });
      output(`      OpenCode ${result.stdout.trim() || "detected"}`);
    } catch {
      warnings.push("OpenCode CLI was not found on PATH. Install it before starting the bridge.");
    }
    const sqliteError = await checkSqliteBinding();
    if (sqliteError === null) {
      output("      SQLite: OK");
    } else {
      output("      SQLite: missing native binding (see warning below)");
      warnings.push(sqliteError);
    }
    output("");

    output("[2/7] Owner and projects...");
    const ownerQq = options.ownerQq ?? (await askOwnerQq(prompt, options.yes === true));
    if (!isNumericQq(ownerQq)) {
      throw new SetupError("invalid", `Owner QQ must be a numeric QQ number, got: ${ownerQq}`);
    }
    output(`      Owner QQ: ${ownerQq}`);
    const projects = await resolveProjects(prompt, options, cwd);
    for (const project of projects) {
      output(`      Project ${project.id}: ${project.path}`);
    }
    output("");

    output("[3/7] Configuring NapCat...");
    const napcat = await resolveNapcatMode(prompt, options, dataDir, configPath, output);
    const accessToken = napcat.accessToken;
    const bridgeToken = randomToken(24);
    const wsUrl = napcat.wsUrl;
    output(`      NapCat mode: ${napcat.mode}`);
    output(`      WebSocket:   ${wsUrl}`);
    warnings.push(...napcat.warnings);
    output("");

    output("[4/7] Writing bridge config...");
    if (options.force === true) {
      const configBackup = backupFile(configPath);
      if (configBackup !== null) warnings.push(`Backed up previous config to ${configBackup}`);
      const envBackup = backupFile(join(dirname(configPath), ".env"));
      if (envBackup !== null) warnings.push(`Backed up previous env file to ${envBackup}`);
    }

    ensureDirectory(dirname(configPath));
    ensureDirectory(dataDir);
    const envPath = join(dirname(configPath), ".env");
    writePublicFile(configPath, renderConfigYaml({ ownerQq, projects, dataDir }));
    writePrivateFile(envPath, renderEnvFile({ wsUrl, accessToken, bridgeToken }));
    output(`      ${configPath}`);
    output(`      ${envPath} (mode 0600)`);
    output("");

    output("[5/7] Installing OpenCode plugin...");
    let pluginPath: string | null = null;
    let bridgeConfigPath: string | null = null;
    if (options.skipPlugin !== true) {
      try {
        const installed = installOpenCodePlugin({
          openCodeConfigDir: defaultOpenCodeConfigDir(defaultConfigHome(env)),
          bridgeUrl: "http://127.0.0.1:8787",
          token: bridgeToken,
          force: options.force,
        });
        pluginPath = installed.pluginPath;
        bridgeConfigPath = installed.bridgeConfigPath;
        warnings.push(...installed.warnings);
        output(`      ${installed.pluginPath}`);
        output(`      ${installed.bridgeConfigPath} (mode 0600)`);
      } catch (error) {
        warnings.push(
          `OpenCode plugin was not installed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      output("      skipped (--skip-plugin)");
    }
    output("");

    output("[6/7] Validating configuration...");
    if (options.skipDoctor !== true) {
      const validation = await validateGeneratedConfig(configPath, {
        ...env,
        NAPCAT_WS_URL: wsUrl,
        NAPCAT_ACCESS_TOKEN: accessToken,
        QQ_BRIDGE_INTERNAL_TOKEN: bridgeToken,
      });
      warnings.push(...validation);
      output("      OK");
    } else {
      output("      skipped (--skip-doctor)");
    }
    output("");
    output("[7/7] Setup complete.");

    return {
      configPath,
      envPath,
      dataDir,
      ownerQq,
      projects,
      napcatMode: napcat.mode,
      napcatStarted: napcat.started,
      napcatUrl: wsUrl,
      napcatAccessToken: accessToken,
      webuiUrl: napcat.webuiUrl,
      webuiToken: napcat.webuiToken,
      pluginPath,
      bridgeConfigPath,
      warnings,
    };
  } finally {
    prompt?.close();
  }
}

async function askOwnerQq(prompt: Prompt | null, yes: boolean): Promise<string> {
  if (prompt !== null) {
    return prompt.ask("Owner QQ number");
  }
  if (yes) {
    throw new SetupError("invalid", "Missing --owner-qq (required with --yes).");
  }
  throw new SetupError("invalid", "Missing owner QQ; pass --owner-qq <qq>.");
}

async function resolveProjects(
  prompt: Prompt | null,
  options: SetupOptions,
  cwd: string,
): Promise<SetupProject[]> {
  if (options.projects !== undefined && options.projects.length > 0) {
    return validateProjects(options.projects);
  }
  if (prompt === null) {
    return [{ id: sanitizeProjectId(basename(cwd)), path: cwd }];
  }

  const projects: SetupProject[] = [];
  for (;;) {
    const path = resolve(await prompt.ask("Project directory", projects.length === 0 ? cwd : ""));
    const id = sanitizeProjectId(await prompt.ask("Project ID", sanitizeProjectId(basename(path))));
    projects.push({ id, path });
    if (!(await prompt.confirm("Add another project?", false))) break;
    if (projects.length >= 10) break;
  }
  return validateProjects(projects);
}

function validateProjects(projects: SetupProject[]): SetupProject[] {
  const seen = new Set<string>();
  return projects.map((project) => {
    const path = resolve(project.path);
    const id = sanitizeProjectId(project.id);
    if (seen.has(id)) throw new SetupError("invalid", `Duplicate project ID: ${id}`);
    seen.add(id);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      throw new SetupError("invalid", `Project directory does not exist: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new SetupError("invalid", `Project path is not a directory: ${path}`);
    }
    return { id, path };
  });
}

async function resolveNapcatMode(
  prompt: Prompt | null,
  options: SetupOptions,
  dataDir: string,
  configPath: string,
  output: (line: string) => void,
): Promise<{
  mode: NapCatMode;
  accessToken: string;
  wsUrl: string;
  started: boolean;
  webuiUrl: string | null;
  webuiToken: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const wsPort = options.wsPort ?? 3001;
  const webuiPort = options.webuiPort ?? 6099;
  let mode = options.napcat;
  let dockerAvailable = false;
  if (mode === undefined) {
    try {
      await detectComposeCommand(options.runner ?? defaultRunner);
      dockerAvailable = true;
    } catch {
      dockerAvailable = false;
    }
    if (prompt !== null) {
      const choices: Array<{ value: NapCatMode; label: string }> = [];
      if (dockerAvailable) {
        choices.push({
          value: "docker",
          label: "Start a new NapCat Docker container (recommended)",
        });
      } else {
        output("      Docker Compose is not available; skipping the Docker option.");
      }
      choices.push({ value: "existing", label: "Use an existing NapCat" });
      choices.push({ value: "skip", label: "Skip for now and configure manually" });
      mode = await prompt.select("NapCat setup:", choices, 0);
    } else {
      mode = "skip";
    }
  }

  if (mode === "docker") {
    const accessToken = options.napcatToken ?? randomToken(24);
    try {
      const result: NapCatDockerResult = await setupNapCatDocker({
        configDir: dirname(configPath),
        dataDir,
        accessToken,
        wsPort,
        webuiPort,
        force: options.force,
        runner: options.runner,
        sleep: options.sleep,
        portAvailable: options.portAvailable ?? isPortAvailable,
        onProgress: (line) => output(`      ${line}`),
      });
      return {
        mode,
        accessToken,
        wsUrl: result.wsUrl,
        started: result.started,
        webuiUrl: result.webuiUrl,
        webuiToken: result.webuiToken,
        warnings: [...warnings, ...result.warnings],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`NapCat Docker setup failed: ${message}`);
      warnings.push(
        "The bridge config will still be written. Fix Docker/ports and rerun setup, or use the existing NapCat mode.",
      );
      return {
        mode,
        accessToken,
        wsUrl: `ws://127.0.0.1:${wsPort}`,
        started: false,
        webuiUrl: null,
        webuiToken: null,
        warnings,
      };
    }
  }

  if (mode === "existing") {
    let wsUrl = options.napcatUrl;
    let accessToken = options.napcatToken;
    if (prompt !== null) {
      wsUrl = await prompt.ask("NapCat WebSocket URL", wsUrl ?? `ws://127.0.0.1:${wsPort}`);
      accessToken = await prompt.ask(
        "NapCat access token (leave empty if not set)",
        accessToken ?? "",
      );
    }
    wsUrl ??= `ws://127.0.0.1:${wsPort}`;
    accessToken ??= "";
    if (accessToken.length === 0) {
      warnings.push("NapCat access token is empty; only use this for loopback testing.");
    }
    return {
      mode,
      accessToken,
      wsUrl,
      started: false,
      webuiUrl: null,
      webuiToken: null,
      warnings,
    };
  }

  const accessToken = options.napcatToken ?? randomToken(24);
  warnings.push(
    "NapCat was not started. Configure its WebSocket server with the token shown below.",
  );
  return {
    mode: "skip",
    accessToken,
    wsUrl: options.napcatUrl ?? `ws://127.0.0.1:${wsPort}`,
    started: false,
    webuiUrl: null,
    webuiToken: null,
    warnings,
  };
}

async function checkSqliteBinding(): Promise<string | null> {
  try {
    const module = await import("better-sqlite3");
    const database = new module.default(":memory:");
    database.close();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Could not locate the bindings file") ||
      message.includes("better_sqlite3.node")
    ) {
      return [
        "SQLite native binding is missing. Fix it before starting the bridge:",
        "  npm cache clean --force",
        "  npm install -g opencode-qq-adapter",
        "If it still fails, install build tools and run: npm rebuild better-sqlite3 --build-from-source",
      ].join("\n");
    }
    return `SQLite check failed: ${message}`;
  }
}

async function validateGeneratedConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  try {
    const loaded = await loadConfig(configPath, { checkPaths: true, env });
    return loaded.warnings;
  } catch (error) {
    throw new SetupError(
      "invalid",
      `Generated configuration failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function formatSetupSummary(result: SetupResult): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("Next steps:");
  if (result.napcatMode === "docker") {
    if (result.napcatStarted) {
      lines.push("1. Open the NapCat WebUI and scan the QQ login QR code:");
      lines.push(`   ${result.webuiUrl ?? "http://127.0.0.1:6099/webui"}`);
      lines.push("   If the token changes after login, run: docker logs -f opencode-qq-napcat");
    } else {
      lines.push("1. NapCat Docker did not start. Fix Docker/ports and rerun setup.");
    }
  } else if (result.napcatMode === "existing") {
    lines.push("1. Using the existing NapCat. Verify its WebSocket token matches .env.");
  } else {
    lines.push("1. Start NapCat and add a WebSocket server in its network settings:");
    lines.push(`   URL:   ${result.napcatUrl}`);
    lines.push(`   Token: ${result.napcatAccessToken || "(empty)"}`);
  }
  lines.push("2. Start OpenCode: opencode serve --service");
  lines.push("   If it is already running, run `opencode service restart` to load the plugin.");
  lines.push("3. Start the bridge: opencode-qq start");
  lines.push("4. Send `!ping` to the bot in a QQ private chat.");
  lines.push("");
  lines.push(`Config:      ${result.configPath}`);
  lines.push(`Environment: ${result.envPath}`);
  if (result.pluginPath !== null) lines.push(`Plugin:      ${result.pluginPath}`);
  if (result.webuiUrl !== null) lines.push(`NapCat UI:   ${result.webuiUrl}`);
  return lines;
}

/** Read a config file without importing the loader (useful for setup tests). */
export function configFileExists(path: string): boolean {
  return existsSync(path);
}

export function readSetupFile(path: string): string | null {
  return readTextIfExists(path);
}
