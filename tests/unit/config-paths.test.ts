import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  envFilesForConfig,
  loadEnvFiles,
  parseEnvFile,
  resolveConfigPath,
} from "../../src/config/paths.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qq-paths-"));
}

describe("config paths", () => {
  it("uses an explicit path first", async () => {
    const dir = await tempDir();
    const path = join(dir, "explicit.yaml");
    expect(resolveConfigPath(path, {}, dir)).toBe(path);
  });

  it("uses OPENCODE_QQ_CONFIG when no explicit path is given", async () => {
    const dir = await tempDir();
    const path = join(dir, "env.yaml");
    expect(resolveConfigPath(undefined, { OPENCODE_QQ_CONFIG: path }, dir)).toBe(path);
  });

  it("prefers a repository config for source checkouts", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "config"));
    const path = join(dir, "config", "config.yaml");
    await writeFile(path, "version: 2\n");
    expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: join(dir, "xdg") }, dir)).toBe(path);
  });

  it("falls back to XDG config", async () => {
    const dir = await tempDir();
    const xdg = join(dir, "xdg");
    expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: xdg }, dir)).toBe(
      join(xdg, "opencode-qq", "config.yaml"),
    );
  });

  it("parses quoted values and exports", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "export FOO=bar",
          'QUOTED="hello world"',
          "SINGLE='value'",
          "EMPTY=",
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({ FOO: "bar", QUOTED: "hello world", SINGLE: "value", EMPTY: "" });
  });

  it("does not override variables already present in the process env", async () => {
    const dir = await tempDir();
    const path = join(dir, ".env");
    await writeFile(path, "KEEP=from-file\nNEW=from-file\n");
    const env: NodeJS.ProcessEnv = { KEEP: "from-shell" };
    loadEnvFiles([path], env);
    expect(env.KEEP).toBe("from-shell");
    expect(env.NEW).toBe("from-file");
  });

  it("orders the explicit env file before config and cwd files", async () => {
    const dir = await tempDir();
    const config = join(dir, "config.yaml");
    const env = { OPENCODE_QQ_ENV_FILE: join(dir, "custom.env") };
    const files = envFilesForConfig(config, join(dir, "cwd"), env);
    expect(files[0]).toBe(join(dir, "custom.env"));
    expect(files).toContain(join(dir, ".env"));
    expect(files).toContain(join(dir, "cwd", ".env"));
  });

  it("builds the XDG default path", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/opencode-qq/config.yaml",
    );
  });
});
