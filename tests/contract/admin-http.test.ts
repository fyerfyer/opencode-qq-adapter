import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { App } from "../../src/app.js";
import { loadConfig } from "../../src/config/loader.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot } from "../helpers/fakes.js";

const ADMIN_PASSWORD = "test-admin-password";
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

interface AdminHarness {
  app: App;
  baseUrl: string;
  configPath: string;
  projectPath: string;
  promptRoot: string;
  cookie: string;
  csrf: string;
}

async function startAdminApp(): Promise<AdminHarness> {
  const root = await mkdtemp(join(tmpdir(), "qq-admin-"));
  const projectPath = join(root, "project");
  const promptRoot = join(root, "prompts");
  const configPath = join(root, "config.yaml");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectPath, { recursive: true }));
  await writeFile(
    configPath,
    stringify({
      version: 1,
      server: { port: 0 },
      onebot: { url: "ws://127.0.0.1:3001", access_token: "test" },
      opencode: { service: { mode: "off", base_url: "http://127.0.0.1:1" } },
      storage: {
        database_path: join(root, "bridge.db"),
        inbox_dir: join(root, "inbox"),
      },
      workspaces: { root: join(root, "workspaces") },
      default_project: "demo",
      users: { "20000": { role: "owner", projects: ["*"] } },
      projects: {
        demo: {
          path: projectPath,
          policy: "standard",
          allowed_users: ["20000"],
        },
      },
      policies: { standard: { read: "allow", edit: "ask", shell: "ask" } },
      admin: { enabled: true },
    }),
    "utf8",
  );

  const loaded = await loadConfig(configPath, { checkPaths: true });
  const config = loaded.config;
  config.server.port = 0;
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, {
    logger,
    store,
    agent: new FakeAgent(),
    onebot,
    configPath,
    adminPassword: ADMIN_PASSWORD,
    promptRoot,
  });
  await app.start();
  disposers.push(async () => {
    await app.stop();
    logger.flush?.();
  });

  const baseUrl = `http://127.0.0.1:${app.httpPort}`;
  const login = await fetch(`${baseUrl}/admin/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const body = (await login.json()) as { csrfToken: string };
  return {
    app,
    baseUrl,
    configPath,
    projectPath,
    promptRoot,
    cookie,
    csrf: body.csrfToken,
  };
}

async function request(
  harness: AdminHarness,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string | null;
    configHash?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: harness.cookie,
    accept: "application/json",
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const csrf = options.csrf === undefined ? harness.csrf : options.csrf;
  if (csrf !== null && options.method !== undefined && options.method !== "GET") {
    headers["x-csrf-token"] = csrf;
  }
  if (options.configHash !== undefined) headers["x-config-hash"] = options.configHash;
  return fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function access(harness: AdminHarness): Promise<{
  configHash: string;
  users: Array<{ qq: string; note?: string }>;
  groups: Array<{ id: string }>;
  projects: Array<{ id: string }>;
  policies: Array<{ name: string }>;
}> {
  const response = await request(harness, "/admin/api/access");
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

describe("Admin HTTP API", () => {
  it("requires a session, protects writes with CSRF, and logs out", async () => {
    const harness = await startAdminApp();
    const unauthenticated = await fetch(`${harness.baseUrl}/admin/api/auth/session`);
    expect(unauthenticated.status).toBe(401);

    const session = await request(harness, "/admin/api/auth/session");
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { authenticated: boolean; csrfToken: string };
    expect(sessionBody.authenticated).toBe(true);
    expect(sessionBody.csrfToken).toBe(harness.csrf);

    const csrfRejected = await request(harness, "/admin/api/conversations/private%3A20000/unbind", {
      method: "POST",
      csrf: null,
    });
    expect(csrfRejected.status).toBe(403);

    const logout = await request(harness, "/admin/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    const after = await request(harness, "/admin/api/overview");
    expect(after.status).toBe(401);
  });

  it("rejects bad passwords and rate limits repeated failures", async () => {
    const harness = await startAdminApp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${harness.baseUrl}/admin/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${harness.baseUrl}/admin/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(limited.status).toBe(429);
  });

  it("changes the admin password and revokes other sessions", async () => {
    const harness = await startAdminApp();
    const secondLogin = await fetch(`${harness.baseUrl}/admin/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(secondLogin.status).toBe(200);
    const secondCookie = secondLogin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");

    const change = await request(harness, "/admin/api/auth/password", {
      method: "POST",
      body: {
        currentPassword: ADMIN_PASSWORD,
        newPassword: "new-admin-password",
      },
    });
    expect(change.status).toBe(200);
    const changeBody = (await change.json()) as { csrfToken: string };
    expect(changeBody.csrfToken).not.toBe(harness.csrf);

    const secondSession = await fetch(`${harness.baseUrl}/admin/api/auth/session`, {
      headers: { cookie: secondCookie },
    });
    expect(secondSession.status).toBe(401);

    const oldPassword = await fetch(`${harness.baseUrl}/admin/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await fetch(`${harness.baseUrl}/admin/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "new-admin-password" }),
    });
    expect(newPassword.status).toBe(200);
  });

  it("edits users with optimistic config hashes and refuses invalid YAML", async () => {
    const harness = await startAdminApp();
    const snapshot = await access(harness);
    expect(snapshot.users.some((user) => user.qq === "20000")).toBe(true);
    expect(snapshot.projects.some((project) => project.id === "demo")).toBe(true);

    const update = await request(harness, "/admin/api/users/20000", {
      method: "PUT",
      configHash: snapshot.configHash,
      body: { role: "owner", projects: ["*"], note: "edited from webui" },
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { hash: string; applied: string[] };
    expect(updateBody.applied).toContain("users");
    const source = await readFile(harness.configPath, "utf8");
    expect(source).toContain("edited from webui");

    const stale = await request(harness, "/admin/api/users/20001", {
      method: "PUT",
      configHash: snapshot.configHash,
      body: { role: "member", projects: ["*"] },
    });
    expect(stale.status).toBe(409);

    const before = await readFile(harness.configPath, "utf8");
    const invalid = await request(harness, "/admin/api/config", {
      method: "PUT",
      body: {
        content: "version: 1\nusers:\n  not-a-qq:\n    role: owner\n",
        expectedHash: updateBody.hash,
      },
    });
    expect(invalid.status).toBe(400);
    expect(await readFile(harness.configPath, "utf8")).toBe(before);

    const comment = await request(harness, "/admin/api/config", {
      method: "PUT",
      body: {
        content: `${before}\n# edited from admin API\n`,
        expectedHash: updateBody.hash,
      },
    });
    expect(comment.status).toBe(200);
    expect(await readFile(harness.configPath, "utf8")).toContain("edited from admin API");
  });

  it("edits groups, projects and policies without sending path keys in the body", async () => {
    const harness = await startAdminApp();
    let snapshot = await access(harness);

    const group = await request(harness, "/admin/api/groups/30001", {
      method: "PUT",
      configHash: snapshot.configHash,
      body: {
        enabled: true,
        mode: "shared",
        allowed_users: ["20000"],
        projects: ["demo"],
      },
    });
    expect(group.status).toBe(200);
    let hash = ((await group.json()) as { hash: string }).hash;
    snapshot = await access(harness);
    expect(snapshot.groups.some((item) => item.id === "30001")).toBe(true);

    const project = await request(harness, "/admin/api/projects/other", {
      method: "PUT",
      configHash: hash,
      body: {
        path: harness.projectPath,
        policy: "standard",
      },
    });
    expect(project.status).toBe(200);
    hash = ((await project.json()) as { hash: string }).hash;
    snapshot = await access(harness);
    expect(snapshot.projects.some((item) => item.id === "other")).toBe(true);

    const policy = await request(harness, "/admin/api/policies/trusted", {
      method: "PUT",
      configHash: hash,
      body: { read: "allow", shell: "ask" },
    });
    expect(policy.status).toBe(200);
    snapshot = await access(harness);
    expect(snapshot.policies.some((item) => item.name === "trusted")).toBe(true);
  });

  it("manages prompt files and backups without path traversal", async () => {
    const harness = await startAdminApp();
    const created = await request(harness, "/admin/api/prompts/qq-code.md", {
      method: "PUT",
      body: { content: "# prompt v1\n" },
    });
    expect(created.status).toBe(200);

    const updated = await request(harness, "/admin/api/prompts/qq-code.md", {
      method: "PUT",
      body: { content: "# prompt v2\n" },
    });
    expect(updated.status).toBe(200);

    const backups = await request(harness, "/admin/api/prompts/qq-code.md/backups");
    expect(backups.status).toBe(200);
    const backupBody = (await backups.json()) as { backups: Array<{ name: string }> };
    expect(backupBody.backups.length).toBeGreaterThan(0);
    const backup = backupBody.backups[0]?.name ?? "";

    const restore = await request(harness, "/admin/api/prompts/qq-code.md/restore", {
      method: "POST",
      body: { backup },
    });
    expect(restore.status).toBe(200);
    const restored = (await restore.json()) as { content: string };
    expect(restored.content).toBe("# prompt v1\n");

    const traversal = await request(harness, "/admin/api/prompts/..%2Fevil.md", {
      method: "PUT",
      body: { content: "nope" },
    });
    expect(traversal.status).toBe(400);

    const invalid = await request(harness, "/admin/api/prompts/evil.txt", {
      method: "PUT",
      body: { content: "nope" },
    });
    expect(invalid.status).toBe(400);
  });

  it("returns dashboard and session data", async () => {
    const harness = await startAdminApp();
    const overview = await request(harness, "/admin/api/overview");
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      status: { status: string };
      config: { projects: number };
    };
    expect(body.config.projects).toBe(1);
    expect(["ok", "degraded"]).toContain(body.status.status);

    const conversations = await request(harness, "/admin/api/conversations");
    expect(conversations.status).toBe(200);
    const data = (await conversations.json()) as { conversations: unknown[] };
    expect(Array.isArray(data.conversations)).toBe(true);
  });
});
