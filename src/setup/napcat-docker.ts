import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";
import {
  backupFile,
  ensureDirectory,
  readJsonIfExists,
  writePrivateFile,
  writePublicFile,
} from "./files.js";

const execFileAsync = promisify(execFile);

export const NAPCAT_IMAGE =
  "mlikiowa/napcat-docker@sha256:2cc70b45244ae3fabc657ffc3aaa4de8fb893518171e519659ab83d80e6d36b5";

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface NapCatDockerOptions {
  configDir: string;
  dataDir: string;
  accessToken: string;
  webuiToken?: string;
  wsPort?: number;
  webuiPort?: number;
  force?: boolean;
  runner?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  portAvailable?: (port: number) => Promise<boolean>;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface NapCatDockerResult {
  started: boolean;
  composePath: string;
  wsUrl: string;
  webuiUrl: string;
  webuiToken: string;
  warnings: string[];
}

export const defaultRunner: CommandRunner = {
  async run(command, args, options = {}) {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

/**
 * Generate a small, loopback-only Compose file for NapCat. The image is
 * pinned by digest so a setup run cannot silently pull a new QQ client build.
 */
export function generateNapCatCompose(options: {
  dataDir: string;
  wsPort: number;
  webuiPort: number;
  webuiToken: string;
}): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return stringifyYaml({
    name: "opencode-qq",
    services: {
      napcat: {
        image: NAPCAT_IMAGE,
        container_name: "opencode-qq-napcat",
        restart: "unless-stopped",
        stop_grace_period: "30s",
        ports: [`127.0.0.1:${options.wsPort}:3001`, `127.0.0.1:${options.webuiPort}:6099`],
        volumes: [
          `${join(options.dataDir, "napcat", "config")}:/app/napcat/config`,
          `${join(options.dataDir, "napcat", "qq")}:/app/.config/QQ`,
        ],
        environment: [
          `NAPCAT_UID=${uid}`,
          `NAPCAT_GID=${gid}`,
          `TZ=${process.env.TZ ?? "Asia/Shanghai"}`,
          `WEBUI_TOKEN=${options.webuiToken}`,
        ],
      },
    },
  });
}

export function generateOneBotConfig(accessToken: string): string {
  return `${JSON.stringify(
    {
      network: {
        httpServers: [],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [
          {
            enable: true,
            name: "opencode-qq",
            host: "0.0.0.0",
            port: 3001,
            reportSelfMessage: false,
            enableForcePushEvent: true,
            messagePostFormat: "array",
            token: accessToken,
            debug: false,
            heartInterval: 30000,
          },
        ],
        websocketClients: [],
        plugins: [],
      },
      musicSignUrl: "",
      enableLocalFile2Url: false,
      parseMultMsg: false,
    },
    null,
    2,
  )}\n`;
}

function updateOneBotConfigSource(source: string, accessToken: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return generateOneBotConfig(accessToken);
  }
  if (!isRecord(parsed)) return generateOneBotConfig(accessToken);

  const network = isRecord(parsed.network) ? parsed.network : {};
  const servers = Array.isArray(network.websocketServers) ? network.websocketServers : [];
  const template = (
    JSON.parse(generateOneBotConfig(accessToken)) as {
      network: { websocketServers: Array<Record<string, unknown>> };
    }
  ).network.websocketServers[0];
  if (template === undefined) return generateOneBotConfig(accessToken);

  const named = servers.findIndex((server) => isRecord(server) && server.name === "opencode-qq");
  const targetIndex = named >= 0 ? named : servers.findIndex((server) => isRecord(server));
  if (targetIndex >= 0) {
    const existing = servers[targetIndex];
    servers[targetIndex] = { ...(isRecord(existing) ? existing : {}), ...template };
  } else {
    servers.push(template);
  }
  network.websocketServers = servers;
  parsed.network = network;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function listOneBotConfigPaths(configPath: string): string[] {
  try {
    return readdirSync(configPath)
      .filter((name) => /^onebot11_.*\.json$/.test(name) || name === "onebot11.json")
      .sort((left, right) => left.localeCompare(right))
      .map((name) => join(configPath, name));
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ContainerInspection {
  configFiles: string | null;
  webuiToken: string | null;
}

async function inspectContainer(runner: CommandRunner, name: string): Promise<ContainerInspection> {
  try {
    const result = await runner.run("docker", ["inspect", name, "--format", "{{json .Config}}"], {
      timeoutMs: 15_000,
    });
    const config = JSON.parse(result.stdout) as {
      Env?: unknown;
      Labels?: unknown;
    };
    const env = Array.isArray(config.Env) ? config.Env : [];
    const webui = env.find(
      (entry): entry is string => typeof entry === "string" && entry.startsWith("WEBUI_TOKEN="),
    );
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const configFiles = labels["com.docker.compose.project.config_files"];
    return {
      configFiles: typeof configFiles === "string" ? configFiles : null,
      webuiToken: webui === undefined ? null : webui.slice("WEBUI_TOKEN=".length),
    };
  } catch {
    return { configFiles: null, webuiToken: null };
  }
}

/** Pick `docker compose` when available, otherwise legacy `docker-compose`. */
export async function detectComposeCommand(
  runner: CommandRunner = defaultRunner,
): Promise<{ command: string; prefix: string[] }> {
  try {
    await runner.run("docker", ["compose", "version"], { timeoutMs: 10_000 });
    return { command: "docker", prefix: ["compose"] };
  } catch {
    try {
      await runner.run("docker-compose", ["--version"], { timeoutMs: 10_000 });
      return { command: "docker-compose", prefix: [] };
    } catch (error) {
      throw new Error(
        "Docker Compose is not available. Install Docker Desktop/Engine with the compose plugin, or choose the existing/skip NapCat mode.",
        { cause: error },
      );
    }
  }
}

export function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  if (port <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function setupNapCatDocker(options: NapCatDockerOptions): Promise<NapCatDockerResult> {
  const runner = options.runner ?? defaultRunner;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = options.onProgress ?? (() => undefined);
  const wsPort = options.wsPort ?? 3001;
  const webuiPort = options.webuiPort ?? 6099;
  const warnings: string[] = [];
  const composePath = join(options.configDir, "napcat-compose.yaml");
  const configPath = join(options.dataDir, "napcat", "config");
  const webuiPath = join(configPath, "webui.json");
  const oneBotPath = join(configPath, "onebot11.json");

  ensureDirectory(configPath);
  ensureDirectory(join(options.dataDir, "napcat", "qq"));
  ensureDirectory(options.configDir);

  const existingWebui = readJsonIfExists<{ token?: string }>(webuiPath);
  const webuiToken = existingWebui?.token ?? options.webuiToken ?? options.accessToken;
  if (existingWebui === null) {
    writePrivateFile(
      webuiPath,
      `${JSON.stringify(
        { host: "0.0.0.0", port: 6099, token: webuiToken, loginRate: 3 },
        null,
        2,
      )}\n`,
    );
  }

  const compose = generateNapCatCompose({
    dataDir: options.dataDir,
    wsPort,
    webuiPort,
    webuiToken,
  });
  writePublicFile(composePath, compose);

  const composeCommand = await detectComposeCommand(runner).catch((error) => {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  });
  progress(
    `Docker Compose detected: ${[composeCommand.command, ...composeCommand.prefix].join(" ")}`,
  );
  const composeArgs = [...composeCommand.prefix, "-f", composePath];

  const container = await runner
    .run("docker", ["ps", "-a", "--filter", "name=opencode-qq-napcat", "--format", "{{.Names}}"], {
      timeoutMs: 15_000,
    })
    .catch(() => ({ stdout: "", stderr: "" }));
  const containerExists = container.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes("opencode-qq-napcat");

  let recreate = false;
  if (containerExists) {
    const existing = await inspectContainer(runner, "opencode-qq-napcat");
    const sameCompose =
      existing.configFiles !== null && resolve(existing.configFiles) === resolve(composePath);
    const sameToken = existing.webuiToken === webuiToken;
    if (sameCompose && sameToken) {
      progress("Reusing existing container: opencode-qq-napcat");
    } else {
      progress(
        "Existing NapCat container uses a different compose file or WebUI token; recreating it...",
      );
      recreate = true;
    }
  } else {
    const checkPort = options.portAvailable ?? isPortAvailable;
    const wsFree = await checkPort(wsPort);
    const webuiFree = await checkPort(webuiPort);
    if (!wsFree || !webuiFree) {
      const busy = [
        !wsFree ? `WebSocket ${wsPort}` : null,
        !webuiFree ? `WebUI ${webuiPort}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      throw new Error(
        `NapCat ports are already in use (${busy}). Stop the other service, change the ports, or choose the existing NapCat mode.`,
      );
    }
    progress(`Ports available: WebSocket ${wsPort}, WebUI ${webuiPort}`);
  }

  progress("Starting NapCat container (this may download the image on first run)...");
  await runner.run(
    composeCommand.command,
    [...composeArgs, "up", "-d", ...(recreate ? ["--force-recreate"] : []), "napcat"],
    {
      cwd: options.configDir,
      timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    },
  );

  const initFile = join(configPath, "napcat.json");
  progress("Waiting for NapCat to initialize its config directory...");
  const ready = await waitForFile(initFile, options.timeoutMs ?? 60_000, sleep);
  if (!ready) warnings.push("NapCat config did not appear within 60s; check `docker logs`.");
  // The entrypoint copies the bundled config files on first start. Waiting for
  // the default OneBot file avoids racing that copy with our token write.
  await waitForFile(oneBotPath, 10_000, sleep);

  const oneBotPaths = listOneBotConfigPaths(configPath);
  const targets = oneBotPaths.length > 0 ? oneBotPaths : [oneBotPath];
  const updated: string[] = [];
  progress("Writing NapCat OneBot WebSocket config (token and port 3001)...");
  for (const path of targets) {
    const source = existsSync(path) ? readFileSync(path, "utf8") : null;
    const next =
      source === null
        ? generateOneBotConfig(options.accessToken)
        : updateOneBotConfigSource(source, options.accessToken);
    if (source === next) continue;
    if (source !== null) backupFile(path);
    writePrivateFile(path, next);
    updated.push(path);
  }
  if (updated.length > 0) {
    warnings.push(
      `Updated the NapCat OneBot WebSocket token in ${updated.length} config file(s): ${updated.join(", ")}`,
    );
  }

  // The container entrypoint may have copied default config files on first
  // start. Restarting after our write makes the OneBot settings effective.
  progress("Restarting NapCat to apply the OneBot config...");
  await runner.run(composeCommand.command, [...composeArgs, "restart", "napcat"], {
    cwd: options.configDir,
    timeoutMs: 120_000,
  });

  return {
    started: true,
    composePath,
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    webuiUrl: `http://127.0.0.1:${webuiPort}/webui?token=${encodeURIComponent(webuiToken)}`,
    webuiToken,
    warnings,
  };
}

async function waitForFile(
  path: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(500);
  }
  return existsSync(path);
}

/** Read the WebUI token so setup can print a usable URL for an existing install. */
export function readWebuiToken(dataDir: string): string | null {
  const path = join(dataDir, "napcat", "config", "webui.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}
