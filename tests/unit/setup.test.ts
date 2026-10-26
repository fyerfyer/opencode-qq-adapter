import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { loadConfig } from "../../src/config/loader.js";
import { parseEnvFile } from "../../src/config/paths.js";
import type { SetupError } from "../../src/setup/files.js";
import { installOpenCodePlugin } from "../../src/setup/plugin.js";
import { formatSetupSummary, runSetup } from "../../src/setup/wizard.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qq-setup-"));
}

async function runTempSetup(overrides: Parameters<typeof runSetup>[0] = {}) {
  const dir = await tempDir();
  const configPath = join(dir, "config.yaml");
  const dataDir = join(dir, "data");
  const result = await runSetup({
    configPath,
    dataDir,
    ownerQq: "12345678",
    projects: [{ id: "demo", path: dir }],
    napcat: "skip",
    agent: "default",
    yes: true,
    skipPlugin: true,
    output: () => undefined,
    ...overrides,
  });
  return { dir, configPath, dataDir, result };
}

describe("setup wizard", () => {
  it("writes a valid config and a private env file", async () => {
    const { configPath, result } = await runTempSetup();
    const envSource = await readFile(result.envPath, "utf8");
    const env = parseEnvFile(envSource);
    expect(env.NAPCAT_ACCESS_TOKEN).toBeTruthy();
    expect(env.QQ_BRIDGE_INTERNAL_TOKEN).toBeTruthy();
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBe(result.adminPassword);
    expect(result.adminPassword).toBeTruthy();
    expect(result.napcatMode).toBe("skip");

    const envMode = (await stat(result.envPath)).mode & 0o777;
    expect(envMode).toBe(0o600);

    const loaded = await loadConfig(configPath, {
      checkPaths: true,
      env: { ...process.env, ...env },
    });
    expect(loaded.config.users["12345678"]?.role).toBe("owner");
    expect(loaded.config.projects.demo?.path).toBe(result.projects[0]?.path);
    expect(loaded.config.default_project).toBe("demo");
    expect(loaded.config.storage.database_path.startsWith(result.dataDir)).toBe(true);
    expect(loaded.config.qq.progress_ack).toBe(false);
    expect(loaded.config.admin.enabled).toBe(true);
    expect(loaded.config.admin.allow_remote).toBe(false);
    expect(result.adminUrl).toBe("http://127.0.0.1:8787/admin");
    expect(formatSetupSummary(result).join("\n")).toContain(result.adminUrl);
  });

  it("does not generate an admin password when the database already exists", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "opencode-qq.db"), "");
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      yes: true,
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBeNull();
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBeUndefined();
  });

  it("accepts an explicit first-run admin password", async () => {
    const { result } = await runTempSetup({ adminPassword: "explicit-admin-password" });
    expect(result.adminPassword).toBe("explicit-admin-password");
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBe("explicit-admin-password");
  });

  it("creates a dedicated qq-code agent and selects it in config", async () => {
    const dir = await tempDir();
    const xdg = join(dir, "xdg");
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "qq-code",
      yes: true,
      skipPlugin: true,
      skipDoctor: true,
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
      output: () => undefined,
    });
    expect(result.agentId).toBe("qq-code");
    expect(result.agentPath).toBe(join(xdg, "opencode", "agents", "qq-code.md"));
    expect(await readFile(result.agentPath ?? "", "utf8")).toContain("QQ remote coding agent");
    const config = await readFile(join(dir, "config.yaml"), "utf8");
    expect(config).toContain("default_agent: qq-code");
  });

  it("creates a missing project directory", async () => {
    const dir = await tempDir();
    const projectPath = join(dir, "new-project");
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "new", path: projectPath }],
      napcat: "skip",
      agent: "default",
      yes: true,
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect((await stat(projectPath)).isDirectory()).toBe(true);
    expect(result.projects[0]?.path).toBe(projectPath);
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const dir = await tempDir();
    const configPath = join(dir, "config.yaml");
    await writeFile(configPath, "version: 1\n");
    await expect(
      runSetup({
        configPath,
        dataDir: join(dir, "data"),
        ownerQq: "12345678",
        projects: [{ id: "demo", path: dir }],
        napcat: "skip",
        agent: "default",
        yes: true,
        skipPlugin: true,
        output: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "exists" } satisfies Partial<SetupError>);
  });

  it("backs up an existing config when --force is used", async () => {
    const { dir, configPath } = await runTempSetup();
    await writeFile(configPath, "version: 1\n# old\n");
    const result = await runSetup({
      configPath,
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      yes: true,
      force: true,
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.configPath).toBe(configPath);
    const files = await readdir(dir);
    expect(files.some((file) => file.startsWith("config.yaml.bak."))).toBe(true);
    expect(await readFile(configPath, "utf8")).toContain("Generated by");
  });

  it("installs the plugin and writes a private bridge config", async () => {
    const dir = await tempDir();
    const result = installOpenCodePlugin({
      openCodeConfigDir: join(dir, "opencode"),
      bridgeUrl: "http://127.0.0.1:8787",
      token: "test-token",
    });
    expect(await readFile(result.pluginPath, "utf8")).toContain("qq_send_image");
    const mode = (await stat(result.bridgeConfigPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    const config = JSON.parse(await readFile(result.bridgeConfigPath, "utf8")) as {
      url: string;
      token: string;
    };
    expect(config).toEqual({ url: "http://127.0.0.1:8787", token: "test-token" });
  });

  it("generates a roleplay project, policy, plugin and persona directory", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const personasDir = join(dataDir, "plugins", "roleplay", "personas");
    const configPath = join(dir, "config.yaml");
    const result = await runSetup({
      configPath,
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      yes: true,
      skipPlugin: true,
      skipDoctor: true,
      withRoleplay: true,
      roleplayPath: fileURLToPath(new URL("../../packages/roleplay", import.meta.url)),
      roleplayPersonas: personasDir,
      roleplayProject: "roleplay",
      output: () => undefined,
    });
    expect(result.roleplay).toMatchObject({
      enabled: true,
      projectId: "roleplay",
      personasDir,
    });
    expect((await stat(personasDir)).isDirectory()).toBe(true);
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    const loaded = await loadConfig(configPath, {
      checkPaths: true,
      env: { ...process.env, ...env },
    });
    expect(loaded.config.projects.roleplay).toMatchObject({
      path: personasDir,
      workspace: "none",
      policy: "roleplay",
      agent: "qq-rp",
    });
    expect(loaded.config.policies.roleplay).toMatchObject({
      read: "allow",
      edit: "deny",
      shell: "deny",
      external_directory: "deny",
    });
    expect(loaded.config.plugins.roleplay?.path).toContain("packages/roleplay");
    expect(loaded.config.plugins.roleplay?.options).toMatchObject({
      project_id: "roleplay",
      personas_dir: personasDir,
      fallback_project: "demo",
    });
    expect(loaded.config.security.allowed_roots.some((root) => root === dataDir)).toBe(true);
    expect(formatSetupSummary(result).join("\n")).toContain("Roleplay");
  });

  it("merges roleplay into an existing config without dropping comments or custom projects", async () => {
    const { dir, configPath, dataDir } = await runTempSetup();
    const customPath = join(dir, "custom-project");
    await mkdir(customPath, { recursive: true });
    const before = await readFile(configPath, "utf8");
    const doc = parse(before) as Record<string, unknown>;
    const projects = doc.projects as Record<string, unknown>;
    projects.custom = {
      path: customPath,
      policy: "standard",
      workspace: "shared",
      allowed_users: ["12345678"],
    };
    await writeFile(configPath, `${stringify(doc)}# keep-this-comment\n`, "utf8");

    const personasDir = join(dataDir, "plugins", "roleplay", "personas");
    const result = await runSetup({
      configPath,
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      yes: true,
      skipPlugin: true,
      skipDoctor: true,
      reconfigure: true,
      withRoleplay: true,
      roleplayPath: fileURLToPath(new URL("../../packages/roleplay", import.meta.url)),
      roleplayPersonas: personasDir,
      output: () => undefined,
    });
    expect(result.roleplay?.enabled).toBe(true);
    const merged = await readFile(configPath, "utf8");
    expect(merged).toContain("# keep-this-comment");
    expect(merged).toContain("custom:");
    expect(merged).toContain("roleplay:");
    const files = await readdir(dir);
    expect(files.some((file) => file.startsWith("config.yaml.bak."))).toBe(true);
  });
});
