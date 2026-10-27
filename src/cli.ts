#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import semver from "semver";
import { ADMIN_USERNAME } from "./admin/auth.js";
import { generatePassword, hashPassword } from "./admin/password.js";
import { adminIndexPath } from "./admin/ui.js";
import { App } from "./app.js";
import { ConfigError, type LoadedConfig, loadConfig } from "./config/loader.js";
import { configHome, envFilesForConfig, loadEnvFiles, resolveConfigPath } from "./config/paths.js";
import type { AppConfig } from "./config/schema.js";
import { buildLogger } from "./observability/logger.js";
import { NapCatOneBotAdapter } from "./onebot/napcat.js";
import { OpenCodeAgent } from "./opencode/agent.js";
import { SetupError } from "./setup/files.js";
import { defaultOpenCodeConfigDir } from "./setup/plugin.js";
import { formatSetupSummary, type NapCatMode, runSetup } from "./setup/wizard.js";
import { SqliteStore } from "./store/sqlite.js";
import { VERSION } from "./version.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("opencode-qq")
    .description("Bridge OpenCode to QQ through NapCat / OneBot 11")
    .version(VERSION);

  program
    .command("setup")
    .description("Create a first-run config and optionally start NapCat with Docker")
    .option("-c, --config <path>", "configuration file")
    .option("--data-dir <path>", "data directory")
    .option("--owner-qq <qq>", "owner QQ number")
    .option("--project <id=path>", "project, repeatable", collectProject, [] as string[])
    .option("--napcat <mode>", "docker | existing | skip")
    .option(
      "--agent <id>",
      "qq-code (create dedicated agent), default, or an existing OpenCode agent ID",
    )
    .option("--napcat-url <url>", "existing NapCat WebSocket URL")
    .option("--napcat-token <token>", "NapCat access token")
    .option(
      "--admin-password <password>",
      "admin password: set for a new database, reset an existing one (default: prompt or generate)",
    )
    .option("--ws-port <port>", "NapCat WebSocket host port", parsePort, 3001)
    .option("--webui-port <port>", "NapCat WebUI host port", parsePort, 6099)
    .option("--yes", "use defaults and do not prompt", false)
    .option("--force", "back up and overwrite existing config", false)
    .option("--reconfigure", "merge managed sections into an existing config", false)
    .option("--with-roleplay", "enable the first-party Roleplay plugin")
    .option("--roleplay-path <path>", "local @opencode-qq/roleplay package path")
    .option("--roleplay-personas <path>", "persona data directory")
    .option("--roleplay-project <id>", "roleplay project id", "roleplay")
    .option("--roleplay-default-persona <id>", "default persona id")
    .option("--skip-plugin", "do not install the OpenCode image plugin", false)
    .option("--skip-doctor", "skip generated config validation", false)
    .action(async (options: SetupCliOptions) => {
      try {
        const projects = parseProjects(options.project);
        const result = await runSetup({
          configPath: options.config,
          dataDir: options.dataDir,
          ownerQq: options.ownerQq,
          projects,
          napcat: parseNapCatMode(options.napcat),
          agent: options.agent,
          napcatUrl: options.napcatUrl,
          napcatToken: options.napcatToken,
          adminPassword: options.adminPassword,
          wsPort: options.wsPort,
          webuiPort: options.webuiPort,
          yes: options.yes,
          force: options.force,
          reconfigure: options.reconfigure,
          withRoleplay: options.withRoleplay,
          roleplayPath: options.roleplayPath,
          roleplayPersonas: options.roleplayPersonas,
          roleplayProject: options.roleplayProject,
          ...(options.roleplayDefaultPersona !== undefined
            ? { roleplayDefaultPersona: options.roleplayDefaultPersona }
            : {}),
          skipPlugin: options.skipPlugin,
          skipDoctor: options.skipDoctor,
          output: (line) => console.log(line),
        });
        for (const warning of result.warnings) console.warn(`warning: ${warning}`);
        console.log(formatSetupSummary(result).join("\n"));
      } catch (error) {
        if (error instanceof SetupError) {
          console.error(`Setup failed (${error.code}): ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  program
    .command("start")
    .description("Start the bridge")
    .option("-c, --config <path>", "configuration file")
    .option("--log-level <level>", "override logging level")
    .option("--allow-missing-paths", "do not fail when project directories are missing", false)
    .action(async (options: { config?: string; logLevel?: string; allowMissingPaths: boolean }) => {
      const configPath = prepareConfig(options.config);
      const loaded = await loadOrReport(configPath, {
        checkPaths: !options.allowMissingPaths,
      });
      if (loaded === null) return;
      const config = loaded.config;
      if (options.logLevel) config.logging.level = normalizeLogLevel(options.logLevel);
      const logger = buildLogger(config);
      for (const warning of loaded.warnings) logger.warn({ warning }, "Configuration warning");
      let app: App;
      try {
        app = new App(config, { logger, configPath: loaded.path });
      } catch (error) {
        logger.fatal({ err: error }, "Bridge initialization failed");
        process.exitCode = 1;
        return;
      }
      let stopping = false;
      const shutdown = async (signal: string) => {
        if (stopping) {
          logger.warn({ signal }, "Shutdown already in progress; forcing exit");
          process.exit(1);
        }
        stopping = true;
        logger.info({ signal }, "Shutting down");
        const force = setTimeout(() => {
          logger.warn({ signal }, "Shutdown timed out; forcing exit");
          process.exit(1);
        }, 15_000);
        try {
          await app.stop();
          clearTimeout(force);
          logger.flush?.();
          process.exit(0);
        } catch (error) {
          clearTimeout(force);
          logger.error({ err: error, signal }, "Shutdown failed");
          process.exit(1);
        }
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGHUP", () => {
        if (stopping) return;
        void app.reloadConfig().then((result) => {
          if (!result.ok) logger.error({ error: result.error }, "SIGHUP config reload failed");
        });
      });
      try {
        await app.start();
      } catch (error) {
        logger.fatal({ err: error }, "Bridge failed to start");
        process.exitCode = 1;
        await app.stop();
        process.exit(1);
      }
    });

  const configCommand = program.command("config").description("Configuration utilities");
  configCommand
    .command("validate")
    .description("Validate configuration without starting the bridge")
    .option("-c, --config <path>", "configuration file")
    .option("--skip-paths", "skip project directory existence checks", false)
    .option("--json", "print machine-readable output", false)
    .action(async (options: { config?: string; skipPaths: boolean; json: boolean }) => {
      const configPath = prepareConfig(options.config);
      try {
        const loaded = await loadConfig(configPath, { checkPaths: !options.skipPaths });
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                path: loaded.path,
                warnings: loaded.warnings,
                projects: Object.keys(loaded.config.projects),
                users: Object.keys(loaded.config.users),
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`OK: ${loaded.path}`);
          console.log(`projects: ${Object.keys(loaded.config.projects).join(", ") || "(none)"}`);
          console.log(`users: ${Object.keys(loaded.config.users).join(", ") || "(none)"}`);
          for (const warning of loaded.warnings) console.log(`warning: ${warning}`);
        }
      } catch (error) {
        reportConfigError(error, options.json);
      }
    });

  program
    .command("doctor")
    .description("Check configuration, database, OneBot and OpenCode connectivity")
    .option("-c, --config <path>", "configuration file")
    .action(async (options: { config?: string }) => {
      const configPath = prepareConfig(options.config);
      await doctor(configPath);
    });

  const adminCommand = program.command("admin").description("Admin WebUI utilities");
  adminCommand
    .command("reset-password")
    .description("Generate a new admin password and revoke existing sessions")
    .option("-c, --config <path>", "configuration file")
    .action(async (options: { config?: string }) => {
      const configPath = prepareConfig(options.config);
      const loaded = await loadOrReport(configPath, { checkPaths: false });
      if (loaded === null) return;
      const store = new SqliteStore(loaded.config.storage.database_path);
      try {
        const now = Date.now();
        const password = generatePassword();
        const passwordHash = await hashPassword(password);
        const existing = store.admin.getUser(ADMIN_USERNAME);
        if (existing === null) {
          store.admin.createUser({
            username: ADMIN_USERNAME,
            passwordHash,
            mustChangePassword: true,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          store.admin.updatePassword(ADMIN_USERNAME, passwordHash, true, now);
        }
        store.admin.deleteSessions();
        console.log(`Admin password reset for ${ADMIN_USERNAME}:`);
        console.log(`  ${password}`);
        console.log("保存后请立即登录 /admin 修改密码。旧会话已全部失效。");
      } finally {
        store.close();
      }
    });

  await program.parseAsync(argv);
}

interface SetupCliOptions {
  config?: string;
  dataDir?: string;
  ownerQq?: string;
  project: string[];
  napcat?: string;
  agent?: string;
  napcatUrl?: string;
  napcatToken?: string;
  adminPassword?: string;
  wsPort: number;
  webuiPort: number;
  yes: boolean;
  force: boolean;
  reconfigure: boolean;
  withRoleplay?: boolean;
  roleplayPath?: string;
  roleplayPersonas?: string;
  roleplayProject: string;
  roleplayDefaultPersona?: string;
  skipPlugin: boolean;
  skipDoctor: boolean;
}

function collectProject(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseProjects(values: string[]): Array<{ id: string; path: string }> | undefined {
  if (values.length === 0) return undefined;
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator > 0) {
      return { id: value.slice(0, separator), path: value.slice(separator + 1) };
    }
    const path = resolve(value);
    const id = path.split(/[\\/]/).filter(Boolean).pop() ?? "main";
    return { id, path };
  });
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseNapCatMode(value: string | undefined): NapCatMode | undefined {
  if (value === undefined) return undefined;
  if (value === "docker" || value === "existing" || value === "skip") return value;
  throw new Error(`Invalid --napcat mode '${value}'; expected docker, existing, or skip`);
}

function prepareConfig(explicit?: string): string {
  const configPath = resolveConfigPath(explicit);
  loadEnvFiles(envFilesForConfig(configPath));
  return configPath;
}

async function loadOrReport(
  path: string,
  options: { checkPaths: boolean },
): Promise<LoadedConfig | null> {
  try {
    return await loadConfig(path, options);
  } catch (error) {
    reportConfigError(error, false);
    return null;
  }
}

function reportConfigError(error: unknown, json: boolean): void {
  process.exitCode = 1;
  if (error instanceof ConfigError) {
    if (json) {
      console.error(
        JSON.stringify(
          { ok: false, code: error.code, message: error.message, details: error.details },
          null,
          2,
        ),
      );
      return;
    }
    console.error(`Configuration error (${error.code}): ${error.message}`);
    for (const detail of error.details) console.error(`  - ${detail}`);
    return;
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

function normalizeLogLevel(value: string): AppConfig["logging"]["level"] {
  const allowed = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
  if ((allowed as readonly string[]).includes(value)) {
    return value as AppConfig["logging"]["level"];
  }
  throw new Error(`Invalid log level '${value}'. Expected one of: ${allowed.join(", ")}`);
}

async function doctor(configPath: string): Promise<void> {
  const configLoad = await loadConfig(configPath, { checkPaths: true }).then(
    (loaded) => ({ ok: true as const, loaded }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!configLoad.ok) {
    reportConfigError(configLoad.error, false);
    return;
  }
  const { config, warnings } = configLoad.loaded;
  let failed = false;
  const report = (ok: boolean, label: string, detail = ""): void => {
    if (!ok) failed = true;
    console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
  };

  console.log(`OpenCode QQ Adapter v${VERSION}`);
  console.log(`config: ${resolve(configPath)}`);
  report(true, "configuration", `${Object.keys(config.projects).length} project(s)`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);

  if (!config.admin.enabled) {
    report(true, "admin WebUI", "disabled");
  } else if (existsSync(adminIndexPath())) {
    report(true, "admin WebUI", `${adminIndexPath()} (first start creates the admin account)`);
  } else {
    report(false, "admin WebUI", "static assets missing; run `pnpm build:webui`");
  }

  for (const [id, project] of Object.entries(config.projects)) {
    report(true, `project ${id}`, `${project.path}${project.hidden ? " (internal)" : ""}`);
  }

  if (config.plugins.roleplay !== undefined) {
    const options = config.plugins.roleplay.options;
    const projectId =
      typeof options.project_id === "string" && options.project_id.length > 0
        ? options.project_id
        : "roleplay";
    const project = config.projects[projectId];
    report(project !== undefined, "roleplay project", projectId);
    if (project !== undefined) {
      report(project.workspace === "none", "roleplay workspace", project.workspace);
      report(project.hidden, "roleplay project hidden", String(project.hidden));
      const personasDir =
        typeof options.personas_dir === "string" && options.personas_dir.length > 0
          ? resolve(options.personas_dir)
          : project.path;
      report(personasDir === resolve(project.path), "personas dir matches project", personasDir);
      report(existsSync(personasDir), "personas dir exists", personasDir);
    }
    const agentDir = defaultOpenCodeConfigDir(configHome(process.env));
    report(
      existsSync(join(agentDir, "agents", "qq-rp.md")),
      "qq-rp agent",
      join(agentDir, "agents", "qq-rp.md"),
    );
    report(
      existsSync(join(agentDir, "agents", "qq-rp-utility.md")),
      "qq-rp-utility agent",
      join(agentDir, "agents", "qq-rp-utility.md"),
    );
    const judge = typeof options.sticker_judge === "string" ? options.sticker_judge : "jev";
    const keyName =
      typeof options.jev_api_key_env === "string" ? options.jev_api_key_env : "TYPESAFE_API_KEY";
    if (judge === "jev" || judge === "hybrid") {
      report(
        (process.env[keyName] ?? "").trim().length > 0,
        "Jev API key",
        `${keyName}${process.env[keyName] ? " (configured)" : " (missing)"}`,
      );
    }
  }

  try {
    const store = new SqliteStore(config.storage.database_path);
    try {
      report(store.ping(), "database", config.storage.database_path);
      const adminUser = store.admin.getUser(ADMIN_USERNAME);
      report(
        true,
        "admin account",
        adminUser === null
          ? config.admin.enabled
            ? "will be created on first start"
            : "admin disabled"
          : "configured",
      );
    } finally {
      store.close();
    }
  } catch (error) {
    report(false, "database", error instanceof Error ? error.message : String(error));
  }

  const logger = buildLogger({ ...config, logging: { ...config.logging, level: "silent" } });
  const agent = new OpenCodeAgent(config.opencode, logger);
  try {
    const health = await agent.health(true);
    report(
      health.healthy,
      "OpenCode",
      health.healthy
        ? `${health.version ?? "unknown"} at ${health.url ?? "discovered service"}`
        : (health.error ?? "unavailable"),
    );
    if (health.healthy && health.version !== null && config.opencode.service.version !== null) {
      report(
        semver.satisfies(health.version, config.opencode.service.version),
        "OpenCode version",
        `${health.version} (requires ${config.opencode.service.version})`,
      );
    }
  } finally {
    await agent.stop();
  }

  const onebot = new NapCatOneBotAdapter(config.onebot, logger);
  await onebot.start();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !onebot.status().connected) {
    await delay(100);
  }
  const onebotStatus = onebot.status();
  const login = onebotStatus.connected ? await onebot.getLoginInfo?.().catch(() => null) : null;
  report(
    onebotStatus.connected,
    "OneBot forward",
    onebotStatus.connected
      ? `connected${login ? ` as ${login.nickname} (${login.userId})` : ""}`
      : (onebotStatus.lastError ?? "not connected"),
  );
  await onebot.stop();

  process.exitCode = failed ? 1 : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
