import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAT_PROJECT_ID } from "../../src/chat/project.js";
import { ConfigError, loadConfig } from "../../src/config/loader.js";

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qq-config-"));
  await mkdir(join(root, "project"), { recursive: true });
  return root;
}

async function writeConfig(root: string, contents: string): Promise<string> {
  const path = join(root, "config.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("config loader", () => {
  it("loads defaults and resolves relative project paths", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: test-token
users:
  "10001":
    role: owner
projects:
  demo:
    path: ./project
default_project: demo
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: true });
    expect(loaded.config.projects.demo?.path).toBe(join(root, "project"));
    expect(loaded.config.onebot.url).toBe("ws://127.0.0.1:3001");
    expect(loaded.config.onebot.reconnect.enabled).toBe(true);
    expect(loaded.config.security.max_queued_prompts).toBe(3);
    expect(loaded.config.opencode.service.mode).toBe("external");
    expect(loaded.warnings.some((warning) => warning.includes("self_id"))).toBe(false);
  });

  it("parses the checked-in example config without removed fields", async () => {
    const path = fileURLToPath(new URL("../../config/config.example.yaml", import.meta.url));
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    expect(loaded.config.projects.demo?.workspace).toBe("shared");
    expect(loaded.config.features).toEqual({ images: true, files: true, metrics: false });
    expect(loaded.config.workspaces).toEqual({
      lock_lease_ms: 120_000,
      renew_interval_ms: 30_000,
    });
    expect(loaded.warnings.some((warning) => warning.includes("已移除"))).toBe(false);
  });

  it("soft-migrates removed project, feature and workspace fields", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
users: {}
projects:
  demo:
    path: ./project
    workspace: per_user
    setup: ["pnpm install"]
    base_branch: main
  legacy:
    path: ./project
    workspace: worktree
features:
  worktrees: true
  forms: true
  images: false
workspaces:
  default_mode: per_user
  root: var/workspaces
  idle_ttl_hours: 12
  max_per_project: 2
  cleanup:
    require_clean: false
    keep_dirty_days: 1
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    expect(loaded.config.projects.demo).toMatchObject({ workspace: "shared" });
    expect(loaded.config.projects.demo).not.toHaveProperty("setup");
    expect(loaded.config.projects.demo).not.toHaveProperty("base_branch");
    expect(loaded.config.projects.legacy?.workspace).toBe("shared");
    expect(loaded.config.features).toEqual({ images: false, files: true, metrics: false });
    expect(loaded.config.workspaces).toEqual({
      lock_lease_ms: 120_000,
      renew_interval_ms: 30_000,
    });
    expect(loaded.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("projects.demo.setup 已移除"),
        expect.stringContaining("projects.demo.base_branch 已移除"),
        expect.stringContaining("projects.demo.workspace 'per_user' 已移除"),
        expect.stringContaining("projects.legacy.workspace 'worktree' 已移除"),
        expect.stringContaining("features.worktrees 已移除"),
        expect.stringContaining("features.forms 已移除"),
        expect.stringContaining("workspaces.cleanup 已移除"),
      ]),
    );
  });

  it("rejects an unknown project workspace after migration", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./project
    workspace: ephemeral
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: false })).rejects.toMatchObject({
      code: "schema",
    });
  });

  it("expands a leading tilde in project paths", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
users: {}
projects:
  demo:
    path: ~/qq-test-project
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    expect(loaded.config.projects.demo?.path).toBe(join(homedir(), "qq-test-project"));
  });

  it("reports missing environment variables", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: \${MISSING_ONEBOT_TOKEN}
users: {}
projects: {}
`,
    );
    await expect(loadConfig(path, { env: {} })).rejects.toMatchObject({
      name: "ConfigError",
      code: "env",
    });
    try {
      await loadConfig(path, { env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).details).toContain(`$${"{MISSING_ONEBOT_TOKEN}"}`);
    }
  });

  it("rejects unknown fields", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
  typo_field: true
`,
    );
    await expect(loadConfig(path, { env: {} })).rejects.toMatchObject({ code: "schema" });
  });

  it("treats empty commented YAML sections as empty objects", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
users:
projects:
workspaces:
logging:
features:
`,
    );
    const loaded = await loadConfig(path, { env: {} });
    expect(loaded.config.users).toEqual({});
    expect(loaded.config.projects[CHAT_PROJECT_ID]).toMatchObject({
      hidden: true,
      workspace: "none",
    });
  });

  it("rejects a default project that does not exist", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
default_project: nope
projects:
  demo:
    path: ./project
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: false })).rejects.toMatchObject({
      code: "semantic",
    });
  });

  it("rejects missing project directories when checking paths", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./does-not-exist
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: true })).rejects.toMatchObject({
      code: "semantic",
    });
  });

  it("rejects an invalid OpenCode version range", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
opencode:
  service:
    version: not-a-range
projects:
  demo:
    path: ./project
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: true })).rejects.toMatchObject({
      code: "semantic",
    });
  });

  it("rejects projects outside security.allowed_roots", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "qq-outside-"));
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
security:
  allowed_roots: [./project]
projects:
  demo:
    path: ${outside}
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: false })).rejects.toMatchObject({
      code: "semantic",
    });
  });

  it("requires a valid Base32 secret when owner 2FA is enabled", async () => {
    const root = await workspace();
    const base = `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./project
`;
    const missing = await writeConfig(
      root,
      `${base}
security:
  admin_2fa:
    enabled: true
`,
    );
    await expect(loadConfig(missing, { env: {} })).rejects.toMatchObject({
      code: "semantic",
    });

    const invalid = await writeConfig(
      root,
      `${base}
security:
  admin_2fa:
    enabled: true
    totp_secret: not-base32!
`,
    );
    await expect(loadConfig(invalid, { env: {} })).rejects.toMatchObject({
      code: "semantic",
    });

    const valid = await writeConfig(
      root,
      `${base}
security:
  admin_2fa:
    enabled: true
    totp_secret: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
`,
    );
    const loaded = await loadConfig(valid, { env: {} });
    expect(loaded.config.security.admin_2fa.enabled).toBe(true);
  });

  it("resolves local plugin paths and the plugin data directory", async () => {
    const root = await workspace();
    await mkdir(join(root, "my-plugin"), { recursive: true });
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./project
plugins:
  my-plugin:
    path: ./my-plugin
    options:
      greeting: hi
storage:
  plugins_dir: ./plugin-data
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: true });
    expect(loaded.config.plugins["my-plugin"]?.path).toBe(join(root, "my-plugin"));
    expect(loaded.config.plugins["my-plugin"]?.options).toEqual({ greeting: "hi" });
    expect(loaded.config.storage.plugins_dir).toBe(join(root, "plugin-data"));
  });

  it("rejects malformed plugin entries", async () => {
    const root = await workspace();
    const base = `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./project
`;
    const both = await writeConfig(
      root,
      `${base}plugins:
  my-plugin:
    package: "@scope/plugin"
    path: ./my-plugin
`,
    );
    await expect(loadConfig(both, { env: {} })).rejects.toMatchObject({ code: "schema" });

    const neither = await writeConfig(
      root,
      `${base}plugins:
  my-plugin:
    options: {}
`,
    );
    await expect(loadConfig(neither, { env: {} })).rejects.toMatchObject({ code: "schema" });

    const badId = await writeConfig(
      root,
      `${base}plugins:
  MyPlugin:
    package: "@scope/plugin"
`,
    );
    await expect(loadConfig(badId, { env: {} })).rejects.toMatchObject({ code: "schema" });
  });

  it("warns when the deprecated per-minute frequency limit is configured", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
security:
  rate_limit:
    prompts_per_minute: 6
users:
  "10001":
    role: owner
    limits:
      prompts_per_minute: 3
projects:
  demo:
    path: ./project
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    expect(loaded.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("security.rate_limit.prompts_per_minute"),
        expect.stringContaining("users.10001.limits.prompts_per_minute"),
      ]),
    );
  });

  it("reports a missing local plugin path during path validation", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./project
plugins:
  missing-plugin:
    path: ./does-not-exist
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: true })).rejects.toMatchObject({
      code: "semantic",
    });
  });

  it("rejects the old config version and removed policy/group sections", async () => {
    const root = await workspace();
    const oldVersion = await writeConfig(
      root,
      `
version: 1
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
projects:
  demo:
    path: ./project
`,
    );
    await expect(loadConfig(oldVersion, { env: {} })).rejects.toMatchObject({ code: "schema" });

    const groups = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
groups:
  "20001":
    enabled: true
projects:
  demo:
    path: ./project
`,
    );
    await expect(loadConfig(groups, { env: {} })).rejects.toMatchObject({ code: "schema" });
  });

  it("validates write_projects against the user's accessible projects", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
users:
  "10001":
    role: member
    projects: [demo]
    write_projects: [other]
projects:
  demo:
    path: ./project
  other:
    path: ./project
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: false })).rejects.toMatchObject({
      code: "semantic",
    });
  });

  it("accepts a wildcard project grant with a specific write project", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
users:
  "10001":
    role: owner
    projects: ["*"]
    write_projects: [demo]
projects:
  demo:
    path: ./project
`,
    );
    const loaded = await loadConfig(path, { env: {}, checkPaths: false });
    expect(loaded.config.users["10001"]?.write_projects).toEqual(["demo"]);
  });

  it("rejects a hidden default project", async () => {
    const root = await workspace();
    const path = await writeConfig(
      root,
      `
version: 2
onebot:
  url: ws://127.0.0.1:3001
  access_token: token
default_project: roleplay
projects:
  roleplay:
    path: ./project
    workspace: none
    hidden: true
`,
    );
    await expect(loadConfig(path, { env: {}, checkPaths: false })).rejects.toMatchObject({
      code: "semantic",
    });
  });
});
