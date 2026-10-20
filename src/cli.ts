#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { App } from "./app.js";
import { ConfigError, type LoadedConfig, loadConfig } from "./config/loader.js";
import type { AppConfig } from "./config/schema.js";
import { buildLogger } from "./observability/logger.js";
import { NapCatOneBotAdapter } from "./onebot/napcat.js";
import { OpenCodeAgent } from "./opencode/adapter.js";
import { SqliteStore } from "./store/sqlite.js";
import { VERSION } from "./version.js";

const DEFAULT_CONFIG = "config/config.yaml";

export async function runCli(argv: string[]): Promise<void> {
  loadDotEnv();
  const program = new Command();
  program
    .name("opencode-qq")
    .description("Bridge OpenCode to QQ through NapCat / OneBot 11")
    .version(VERSION);

  program
    .command("start")
    .description("Start the bridge")
    .option("-c, --config <path>", "configuration file", DEFAULT_CONFIG)
    .option("--log-level <level>", "override logging level")
    .option("--allow-missing-paths", "do not fail when project directories are missing", false)
    .action(async (options: { config: string; logLevel?: string; allowMissingPaths: boolean }) => {
      const loaded = await loadOrReport(options.config, {
        checkPaths: !options.allowMissingPaths,
      });
      if (loaded === null) return;
      const config = loaded.config;
      if (options.logLevel) config.logging.level = normalizeLogLevel(options.logLevel);
      const logger = buildLogger(config);
      for (const warning of loaded.warnings) logger.warn({ warning }, "Configuration warning");
      const app = new App(config, { logger });
      let stopping = false;
      const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        logger.info({ signal }, "Shutting down");
        await app.stop();
        process.exitCode = 0;
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
      try {
        await app.start();
      } catch (error) {
        logger.fatal({ err: error }, "Bridge failed to start");
        process.exitCode = 1;
        await app.stop();
      }
    });

  const configCommand = program.command("config").description("Configuration utilities");
  configCommand
    .command("validate")
    .description("Validate configuration without starting the bridge")
    .option("-c, --config <path>", "configuration file", DEFAULT_CONFIG)
    .option("--skip-paths", "skip project directory existence checks", false)
    .option("--json", "print machine-readable output", false)
    .action(async (options: { config: string; skipPaths: boolean; json: boolean }) => {
      try {
        const loaded = await loadConfig(options.config, { checkPaths: !options.skipPaths });
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
    .option("-c, --config <path>", "configuration file", DEFAULT_CONFIG)
    .action(async (options: { config: string }) => {
      await doctor(options.config);
    });

  await program.parseAsync(argv);
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

  for (const [id, project] of Object.entries(config.projects)) {
    report(true, `project ${id}`, project.path);
  }

  const store = new SqliteStore(config.storage.database_path);
  try {
    report(store.ping(), "database", config.storage.database_path);
  } finally {
    store.close();
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

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    console.warn(
      `warning: could not load .env: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
