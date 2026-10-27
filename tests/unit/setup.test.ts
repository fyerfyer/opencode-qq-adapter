import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ADMIN_USERNAME } from "../../src/admin/auth.js";
import { hashPassword, verifyPassword } from "../../src/admin/password.js";
import { loadConfig } from "../../src/config/loader.js";
import { parseEnvFile } from "../../src/config/paths.js";
import type { SetupError } from "../../src/setup/files.js";
import { probeNapcatWebSocket } from "../../src/setup/napcat-probe.js";
import { installOpenCodePlugin } from "../../src/setup/plugin.js";
import type { Prompt } from "../../src/setup/prompt.js";
import { formatSetupSummary, runSetup } from "../../src/setup/wizard.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeNapCatServer } from "../helpers/fake-napcat.js";

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

async function createAdminDatabase(dataDir: string, password: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "opencode-qq.db");
  const store = new SqliteStore(path);
  try {
    const now = Date.now();
    store.admin.createUser({
      username: ADMIN_USERNAME,
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }
  return path;
}

async function readAdminHash(path: string): Promise<string> {
  const store = new SqliteStore(path);
  try {
    return store.admin.getUser(ADMIN_USERNAME)?.passwordHash ?? "";
  } finally {
    store.close();
  }
}

function promptStub(overrides: Partial<Prompt> = {}): Prompt {
  return {
    ask: async (_question, defaultValue = "") => defaultValue,
    confirm: async (_question, defaultValue) => defaultValue,
    select: async (_question, options, defaultIndex = 0) => {
      const option = options[defaultIndex] ?? options[0];
      if (option === undefined) throw new Error("No options");
      return option.value;
    },
    password: async () => "",
    close: () => undefined,
    ...overrides,
  };
}

function queuedAnswers(values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? "";
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

  it("does not modify an existing admin password unless explicitly asked", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const databasePath = await createAdminDatabase(dataDir, "existing-admin-password");
    const before = await readAdminHash(databasePath);
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
    expect(await readAdminHash(databasePath)).toBe(before);
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBeUndefined();
    const summary = formatSetupSummary(result).join("\n");
    expect(summary).toContain("unchanged");
    expect(summary).toContain(`opencode-qq admin reset-password --config ${result.configPath}`);
  });

  it("updates an existing admin password when one is provided", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const databasePath = await createAdminDatabase(dataDir, "old-admin-password");
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      adminPassword: "new-admin-password",
      yes: true,
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBe("new-admin-password");
    const hash = await readAdminHash(databasePath);
    expect(await verifyPassword("new-admin-password", hash)).toBe(true);
    expect(await verifyPassword("old-admin-password", hash)).toBe(false);
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBeUndefined();
    expect(formatSetupSummary(result).join("\n")).toContain("new-admin-password");
  });

  it("accepts an explicit first-run admin password", async () => {
    const { result } = await runTempSetup({ adminPassword: "explicit-admin-password" });
    expect(result.adminPassword).toBe("explicit-admin-password");
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBe("explicit-admin-password");
  });

  it("writes an admin password with spaces and hash characters safely", async () => {
    const { result } = await runTempSetup({ adminPassword: "my admin # password" });
    expect(result.adminPassword).toBe("my admin # password");
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBe("my admin # password");
  });

  it("prompts for an admin password on a fresh database", async () => {
    const dir = await tempDir();
    const passwords = queuedAnswers(["chosen-admin-password", "chosen-admin-password"]);
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      prompt: promptStub({ password: async () => passwords() }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBe("chosen-admin-password");
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBe("chosen-admin-password");
  });

  it("generates an admin password when the interactive password is empty", async () => {
    const dir = await tempDir();
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      prompt: promptStub({ password: async () => "" }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.OPENCODE_QQ_ADMIN_PASSWORD).toBe(result.adminPassword);
  });

  it("reprompts when a new admin password is too short or does not match", async () => {
    const dir = await tempDir();
    const passwords = queuedAnswers([
      "short",
      "valid-admin-password",
      "different-password",
      "valid-admin-password",
      "valid-admin-password",
    ]);
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      prompt: promptStub({ password: async () => passwords() }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBe("valid-admin-password");
  });

  it("resets an existing admin password by default in interactive setup", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const databasePath = await createAdminDatabase(dataDir, "old-admin-password");
    const passwords = queuedAnswers(["default-new-password", "default-new-password"]);
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      withRoleplay: false,
      prompt: promptStub({ password: async () => passwords() }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBe("default-new-password");
    const hash = await readAdminHash(databasePath);
    expect(await verifyPassword("default-new-password", hash)).toBe(true);
    expect(await verifyPassword("old-admin-password", hash)).toBe(false);
  });

  it("keeps an existing admin password when the user explicitly chooses keep", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const databasePath = await createAdminDatabase(dataDir, "old-admin-password");
    const before = await readAdminHash(databasePath);
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      withRoleplay: false,
      prompt: promptStub({
        select: (async <T extends string>() => "keep" as T) as Prompt["select"],
      }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBeNull();
    expect(await readAdminHash(databasePath)).toBe(before);
    expect(formatSetupSummary(result).join("\n")).toContain("unchanged");
  });

  it("resets an existing admin password from the interactive prompt", async () => {
    const dir = await tempDir();
    const dataDir = join(dir, "data");
    const databasePath = await createAdminDatabase(dataDir, "old-admin-password");
    const passwords = queuedAnswers(["new-admin-password", "new-admin-password"]);
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "skip",
      agent: "default",
      prompt: promptStub({
        select: (async <T extends string>() => "reset" as T) as Prompt["select"],
        password: async () => passwords(),
      }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.adminPassword).toBe("new-admin-password");
    const hash = await readAdminHash(databasePath);
    expect(await verifyPassword("new-admin-password", hash)).toBe(true);
    expect(await verifyPassword("old-admin-password", hash)).toBe(false);
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

  it("uses a newly entered NapCat token when reconfiguring an existing env", async () => {
    const { dir, configPath, dataDir } = await runTempSetup({
      napcat: "existing",
      napcatUrl: "ws://127.0.0.1:3001",
      napcatToken: "old-token",
    });
    const result = await runSetup({
      configPath,
      dataDir,
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "existing",
      napcatUrl: "ws://127.0.0.1:3001",
      napcatToken: "new-token",
      agent: "default",
      yes: true,
      reconfigure: true,
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(result.napcatAccessToken).toBe("new-token");
    const env = parseEnvFile(await readFile(result.envPath, "utf8"));
    expect(env.NAPCAT_ACCESS_TOKEN).toBe("new-token");
  });

  it("defaults to the existing NapCat when .env already has a connection", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, ".env"),
      "# existing\nNAPCAT_WS_URL=ws://127.0.0.1:3001\nNAPCAT_ACCESS_TOKEN=existing-token\n",
      { mode: 0o600 },
    );
    let choices: string[] = [];
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      agent: "default",
      withRoleplay: false,
      prompt: promptStub({
        select: (async <T extends string>(
          _question: string,
          options: Array<{ value: T; label: string }>,
          defaultIndex = 0,
        ) => {
          choices = options.map((option) => option.label);
          return options[defaultIndex]?.value ?? options[0]?.value;
        }) as Prompt["select"],
        password: async () => "",
      }),
      probeNapcat: async () => ({ ok: true, code: "ok" }),
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(choices[0]).toContain("existing NapCat");
    expect(result.napcatMode).toBe("existing");
    expect(result.napcatAccessToken).toBe("existing-token");
  });

  it("shows both source and installed start commands in the summary", async () => {
    const { result } = await runTempSetup();
    const summary = formatSetupSummary(result).join("\n");
    expect(summary).toContain("pnpm start");
    expect(summary).toContain(`opencode-qq start --config ${result.configPath}`);
  });

  it("detects a valid and an invalid NapCat access token", async () => {
    const server = new FakeNapCatServer();
    await server.start("probe-token");
    try {
      await expect(probeNapcatWebSocket(server.url, "probe-token")).resolves.toMatchObject({
        ok: true,
      });
      const invalid = await probeNapcatWebSocket(server.url, "wrong-token");
      expect(invalid.ok).toBe(false);
      expect(invalid.code).toBe("token_rejected");
      expect(invalid.error).toContain("401");
    } finally {
      await server.stop();
    }
  });

  it("warns when the existing NapCat token probe fails", async () => {
    const { result } = await runTempSetup({
      napcat: "existing",
      napcatUrl: "ws://127.0.0.1:3001",
      napcatToken: "stale-token",
      probeNapcat: async () => ({
        ok: false,
        code: "token_rejected",
        error: "NapCat rejected the token (HTTP 401)",
      }),
    });
    expect(result.warnings.join("\n")).toContain("HTTP 401");
    expect(result.napcatAccessToken).toBe("stale-token");
  });

  it("continues without retrying when NapCat is not accepting connections", async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    let confirmCalls = 0;
    const passwords = queuedAnswers(["", "admin-password-123", "admin-password-123"]);
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "existing",
      napcatUrl: "ws://127.0.0.1:3001",
      napcatToken: "unavailable-token",
      agent: "default",
      withRoleplay: false,
      prompt: promptStub({
        password: async () => passwords(),
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      }),
      probeNapcat: async () => ({
        ok: false,
        code: "unavailable",
        error: "socket hang up",
      }),
      skipPlugin: true,
      skipDoctor: true,
      output: (line) => lines.push(line),
    });
    expect(confirmCalls).toBe(0);
    expect(result.warnings.join("\n")).toContain("socket hang up");
    expect(lines.join("\n")).toContain("Setup will continue");
  });

  it("lets the user retry the NapCat URL and token after a failed probe", async () => {
    const dir = await tempDir();
    const answers = queuedAnswers([
      "ws://127.0.0.1:3002",
      "bad-token",
      "ws://127.0.0.1:3003",
      "good-token",
    ]);
    const probes: string[] = [];
    const result = await runSetup({
      configPath: join(dir, "config.yaml"),
      dataDir: join(dir, "data"),
      ownerQq: "12345678",
      projects: [{ id: "demo", path: dir }],
      napcat: "existing",
      agent: "default",
      prompt: promptStub({
        ask: async (_question, defaultValue = "") => answers() || defaultValue,
        password: async () => answers(),
        confirm: async () => true,
      }),
      probeNapcat: async (_url, token) => {
        probes.push(token);
        return probes.length === 1
          ? {
              ok: false,
              code: "token_rejected" as const,
              error: "NapCat rejected the token (HTTP 401)",
            }
          : { ok: true, code: "ok" as const };
      },
      skipPlugin: true,
      skipDoctor: true,
      output: () => undefined,
    });
    expect(probes).toEqual(["bad-token", "good-token"]);
    expect(result.napcatUrl).toBe("ws://127.0.0.1:3003");
    expect(result.napcatAccessToken).toBe("good-token");
  });
});
