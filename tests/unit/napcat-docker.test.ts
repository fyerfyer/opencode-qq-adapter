import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommandRunner,
  generateNapCatCompose,
  generateOneBotConfig,
  setupNapCatDocker,
} from "../../src/setup/napcat-docker.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qq-napcat-"));
}

function fakeRunner(options: {
  dataDir: string;
  onUp?: () => Promise<void>;
  failCompose?: boolean;
}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args]);
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        if (options.failCompose) throw new Error("no compose");
        return { stdout: "Docker Compose version v2", stderr: "" };
      }
      if (args.includes("ps")) return { stdout: "", stderr: "" };
      if (args.includes("up")) {
        await options.onUp?.();
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

describe("NapCat Docker setup", () => {
  it("generates a loopback-only compose file with pinned image", () => {
    const compose = generateNapCatCompose({
      dataDir: "/var/lib/opencode-qq",
      wsPort: 3001,
      webuiPort: 6099,
      webuiToken: "webui-token",
    });
    expect(compose).toContain("mlikiowa/napcat-docker@sha256:");
    expect(compose).toContain("127.0.0.1:3001:3001");
    expect(compose).toContain("127.0.0.1:6099:6099");
    expect(compose).toContain("/var/lib/opencode-qq/napcat/config:/app/napcat/config");
  });

  it("generates an OneBot config with the bridge token", () => {
    const parsed = JSON.parse(generateOneBotConfig("secret-token")) as {
      network: { websocketServers: Array<{ port: number; token: string }> };
    };
    expect(parsed.network.websocketServers[0]).toMatchObject({ port: 3001, token: "secret-token" });
  });

  it("starts the container, writes OneBot config and restarts it", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const configDir = join(dir, "config");
    await mkdir(join(dataDir, "napcat", "config"), { recursive: true });
    const { runner, calls } = fakeRunner({
      dataDir,
      onUp: async () => {
        await writeFile(join(dataDir, "napcat", "config", "napcat.json"), "{}");
        await writeFile(join(dataDir, "napcat", "config", "onebot11.json"), "{}\n");
      },
    });

    const result = await setupNapCatDocker({
      configDir,
      dataDir,
      accessToken: "onebot-token",
      webuiToken: "webui-token",
      force: true,
      runner,
      sleep: async () => undefined,
      portAvailable: async () => true,
    });

    expect(result.started).toBe(true);
    expect(result.wsUrl).toBe("ws://127.0.0.1:3001");
    expect(result.webuiUrl).toContain("webui-token");
    const onebot = JSON.parse(
      await readFile(join(dataDir, "napcat", "config", "onebot11.json"), "utf8"),
    ) as { network: { websocketServers: Array<{ token: string }> } };
    expect(onebot.network.websocketServers[0]?.token).toBe("onebot-token");
    expect(calls.some((call) => call.includes("restart"))).toBe(true);
    expect(calls.some((call) => call.includes("up"))).toBe(true);
  });

  it("does not overwrite an existing OneBot config without force", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const configDir = join(dir, "config");
    await mkdir(join(dataDir, "napcat", "config"), { recursive: true });
    const onebotPath = join(dataDir, "napcat", "config", "onebot11.json");
    await writeFile(onebotPath, '{"network":{"websocketServers":[]}}\n');
    const { runner } = fakeRunner({
      dataDir,
      onUp: async () => {
        await writeFile(join(dataDir, "napcat", "config", "napcat.json"), "{}");
      },
    });

    const result = await setupNapCatDocker({
      configDir,
      dataDir,
      accessToken: "new-token",
      runner,
      sleep: async () => undefined,
      portAvailable: async () => true,
    });

    expect(result.warnings.some((warning) => warning.includes("left untouched"))).toBe(true);
    expect(await readFile(onebotPath, "utf8")).toContain('"websocketServers":[]');
  });

  it("fails clearly when a port is occupied", async () => {
    const dir = await tempDir();
    const { runner } = fakeRunner({ dataDir: join(dir, "data") });
    await expect(
      setupNapCatDocker({
        configDir: join(dir, "config"),
        dataDir: join(dir, "data"),
        accessToken: "token",
        runner,
        portAvailable: async (port) => port !== 3001,
      }),
    ).rejects.toThrow(/ports are already in use/i);
  });
});
