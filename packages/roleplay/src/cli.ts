#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  defaultRoleplayConfigPath,
  runRoleplayDoctor,
  runRoleplaySetup,
} from "./setup.js";

const HELP = `opencode-qq-roleplay

Usage:
  opencode-qq-roleplay setup [options]
  opencode-qq-roleplay doctor [options]

Setup options:
  -c, --config <path>             bridge config.yaml (default: OPENCODE_QQ_CONFIG, repo config, or XDG)
      --project <id>              Roleplay project ID (default: roleplay)
      --personas <path>           persona directory
      --plugin-path <path>        @opencode-qq/roleplay package directory
      --default-persona <id>      optional default persona
      --fallback-project <id>     project restored by !rp off
      --dry-run                   print the merged YAML without writing
      --no-backup                 skip the timestamped config backup
  -h, --help                      show this help

Doctor options:
  -c, --config <path>             bridge config.yaml
`;

export async function runRoleplayCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      project: { type: "string" },
      personas: { type: "string" },
      "plugin-path": { type: "string" },
      "default-persona": { type: "string" },
      "fallback-project": { type: "string" },
      "dry-run": { type: "boolean" },
      "no-backup": { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.help === true || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "setup") {
    const result = await runRoleplaySetup({
      ...(values.config !== undefined ? { configPath: values.config } : {}),
      ...(values.project !== undefined ? { projectId: values.project } : {}),
      ...(values.personas !== undefined ? { personasDir: values.personas } : {}),
      ...(values["plugin-path"] !== undefined ? { pluginPath: values["plugin-path"] } : {}),
      ...(values["default-persona"] !== undefined
        ? { defaultPersona: values["default-persona"] }
        : {}),
      ...(values["fallback-project"] !== undefined
        ? { fallbackProject: values["fallback-project"] }
        : {}),
      ...(values["dry-run"] === true ? { dryRun: true } : {}),
      ...(values["no-backup"] === true ? { noBackup: true } : {}),
    });
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    if (result.changed) {
      console.log(
        values["dry-run"] === true
          ? `Roleplay config preview (not written): ${result.configPath}`
          : `Roleplay setup complete: ${result.configPath}`,
      );
    } else {
      console.log(`Roleplay config already up to date: ${result.configPath}`);
    }
    console.log(`  Project:  ${result.projectId}`);
    console.log(`  Personas: ${result.personasDir}`);
    console.log(`  Plugin:   ${result.pluginPath}`);
    if (result.fallbackProject !== null) {
      console.log(`  Fallback: ${result.fallbackProject}`);
    }
    if (result.defaultPersona !== null) {
      console.log(`  Default:  ${result.defaultPersona}`);
    }
    console.log("");
    console.log(`Next: opencode-qq-roleplay doctor --config ${result.configPath}`);
    return 0;
  }

  if (command === "doctor") {
    const result = await runRoleplayDoctor({
      ...(values.config !== undefined ? { configPath: values.config } : {}),
    });
    console.log(`Roleplay doctor: ${result.configPath}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}`);
    }
    return result.ok ? 0 : 1;
  }

  console.error(`Unknown command: ${command}\n`);
  console.error(HELP);
  return 2;
}

if (isMainModule()) {
  runRoleplayCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export { defaultRoleplayConfigPath };
