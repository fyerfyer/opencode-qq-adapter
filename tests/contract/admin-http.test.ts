import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { App } from "../../src/app.js";
import { loadConfig } from "../../src/config/loader.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot, makeIncomingMessage, waitFor } from "../helpers/fakes.js";

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
  agent: FakeAgent;
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
      version: 2,
      server: { port: 0 },
      onebot: { url: "ws://127.0.0.1:3001", access_token: "test" },
      opencode: { service: { mode: "off", base_url: "http://127.0.0.1:1" } },
      storage: {
        database_path: join(root, "bridge.db"),
        inbox_dir: join(root, "inbox"),
      },
      workspaces: { root: join(root, "workspaces") },
      security: { rate_limit: { runs_per_hour: 30 } },
      default_project: "demo",
      users: {
        "20000": { role: "owner", projects: ["*"], write_projects: ["*"] },
      },
      projects: {
        demo: {
          path: projectPath,
        },
      },
      plugins: {
        "hello-fixture": {
          path: join(process.cwd(), "tests/fixtures/plugins/hello"),
          options: { secretKey: "TEST_PLUGIN_KEY" },
        },
      },
      admin: { enabled: true },
    }),
    "utf8",
  );

  const loaded = await loadConfig(configPath, { checkPaths: true });
  const config = loaded.config;
  config.server.port = 0;
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const agent = new FakeAgent();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, {
    logger,
    store,
    agent,
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
    agent,
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
  users: Array<{
    qq: string;
    note?: string;
    write_projects: string[];
    hourlyLimit: number | null;
    hourlyUsage: number;
  }>;
  projects: Array<{ id: string; hidden: boolean }>;
  defaults: { hourlyLimit: number | null };
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
    expect(snapshot.projects.some((project) => project.id === "@chat")).toBe(false);

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
        content: "version: 2\nusers:\n  not-a-qq:\n    role: owner\n",
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

  it("stores and exposes a user-level unlimited hourly quota", async () => {
    const harness = await startAdminApp();
    let snapshot = await access(harness);
    expect(snapshot.defaults.hourlyLimit).toBe(30);

    const update = await request(harness, "/admin/api/users/20000", {
      method: "PUT",
      configHash: snapshot.configHash,
      body: {
        role: "owner",
        projects: ["*"],
        write_projects: ["*"],
        limits: { runs_per_hour: null },
      },
    });
    expect(update.status).toBe(200);

    const source = await readFile(harness.configPath, "utf8");
    expect(source).toContain("runs_per_hour: null");

    snapshot = await access(harness);
    const user = snapshot.users.find((item) => item.qq === "20000");
    expect(user).toMatchObject({ hourlyLimit: null, hourlyUsage: 0 });
  });

  it("edits users and internal projects without sending path keys in the body", async () => {
    const harness = await startAdminApp();
    let snapshot = await access(harness);

    const user = await request(harness, "/admin/api/users/20001", {
      method: "PUT",
      configHash: snapshot.configHash,
      body: {
        role: "member",
        projects: ["demo"],
        write_projects: [],
      },
    });
    expect(user.status).toBe(200);
    const hash = ((await user.json()) as { hash: string }).hash;
    snapshot = await access(harness);
    expect(snapshot.users.some((item) => item.qq === "20001")).toBe(true);
    expect(snapshot.users.find((item) => item.qq === "20001")?.write_projects).toEqual([]);

    const project = await request(harness, "/admin/api/projects/other", {
      method: "PUT",
      configHash: hash,
      body: {
        path: harness.projectPath,
        hidden: true,
      },
    });
    expect(project.status).toBe(200);
    snapshot = await access(harness);
    expect(snapshot.projects.find((item) => item.id === "other")?.hidden).toBe(true);
    expect(snapshot.projects.some((item) => item.id === "other")).toBe(true);
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

  it("writes a plugin-referenced secret and reloads that plugin", async () => {
    const harness = await startAdminApp();
    const response = await request(harness, "/admin/api/plugins/hello-fixture/secrets", {
      method: "PUT",
      body: { key: "TEST_PLUGIN_KEY", value: "plugin-secret-value" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: string;
      configured: boolean;
      reload: { ok: boolean } | null;
    };
    expect(body).toMatchObject({
      key: "TEST_PLUGIN_KEY",
      configured: true,
      reload: { ok: true },
    });
    expect(await readFile(join(dirname(harness.configPath), ".env"), "utf8")).toContain(
      "TEST_PLUGIN_KEY=plugin-secret-value",
    );
    expect(JSON.stringify(body)).not.toContain("plugin-secret-value");

    const rejected = await request(harness, "/admin/api/plugins/hello-fixture/secrets", {
      method: "PUT",
      body: { key: "UNRELATED_KEY", value: "nope" },
    });
    expect(rejected.status).toBe(400);
  });

  it("reloads OpenCode configuration from the admin API", async () => {
    const harness = await startAdminApp();
    const response = await request(harness, "/admin/api/opencode/reload", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.agent.reloads).toBe(1);
  });

  it("defers an OpenCode reload until the active run finishes", async () => {
    const harness = await startAdminApp();
    harness.agent.autoComplete = false;
    await harness.app.conversations.submit(makeIncomingMessage({ text: "hold the run" }), "demo");
    await waitFor(
      () => harness.app.conversations.status("private:20000").activeRun?.sessionId !== null,
      3000,
      "active run",
    );

    const response = await request(harness, "/admin/api/opencode/reload", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      deferred: true,
      activeRuns: 1,
      queuedRuns: 0,
    });
    expect(harness.agent.reloads).toBe(0);

    const sessionId = harness.app.conversations.status("private:20000").activeRun?.sessionId ?? "";
    harness.agent.complete(sessionId);
    await waitFor(() => harness.agent.reloads === 1, 3000, "deferred reload");
  });

  it("updates an agent model and hot-reloads OpenCode", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(
      join(harness.promptRoot, "my-agent.md"),
      "---\ndescription: Mine\n---\n\nBody\n",
      "utf8",
    );

    const response = await request(harness, "/admin/api/prompts/my-agent.md/model", {
      method: "PUT",
      body: { model: "fake/model-b" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      prompt: { model: string | null; content: string };
      reload: { ok: boolean };
    };
    expect(body.prompt.model).toBe("fake/model-b");
    expect(body.reload.ok).toBe(true);
    expect(harness.agent.reloads).toBe(1);
    expect(await readFile(join(harness.promptRoot, "my-agent.md"), "utf8")).toContain(
      "model: fake/model-b",
    );
  });

  it("reloads OpenCode after saving agent prompt content", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(join(harness.promptRoot, "my-agent.md"), "Body\n", "utf8");

    const response = await request(harness, "/admin/api/prompts/my-agent.md", {
      method: "PUT",
      body: { content: "---\n---\n\nChanged\n" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reload: { ok: true } });
    expect(harness.agent.reloads).toBe(1);
  });

  it("refuses to save an agent model while a run is active", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(
      join(harness.promptRoot, "my-agent.md"),
      "---\ndescription: Mine\n---\n\nBody\n",
      "utf8",
    );
    harness.agent.autoComplete = false;
    await harness.app.conversations.submit(makeIncomingMessage({ text: "hold" }), "demo");
    await waitFor(
      () => harness.app.conversations.status("private:20000").activeRun?.sessionId !== null,
      3000,
      "active run",
    );

    const response = await request(harness, "/admin/api/prompts/my-agent.md/model", {
      method: "PUT",
      body: { model: "fake/model-b" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "agent_config_busy" });
    expect(harness.agent.reloads).toBe(0);
    expect(await readFile(join(harness.promptRoot, "my-agent.md"), "utf8")).not.toContain(
      "model: fake/model-b",
    );

    const sessionId = harness.app.conversations.status("private:20000").activeRun?.sessionId ?? "";
    harness.agent.complete(sessionId);
    await waitFor(
      () => harness.app.conversations.status("private:20000").activeRun === null,
      3000,
      "run completion",
    );

    const retry = await request(harness, "/admin/api/prompts/my-agent.md/model", {
      method: "PUT",
      body: { model: "fake/model-b" },
    });
    expect(retry.status).toBe(200);
    expect(harness.agent.reloads).toBe(1);
  });

  it("refuses to save agent prompt content while a run is active", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(join(harness.promptRoot, "my-agent.md"), "Body\n", "utf8");
    harness.agent.autoComplete = false;
    await harness.app.conversations.submit(makeIncomingMessage({ text: "hold" }), "demo");
    await waitFor(
      () => harness.app.conversations.status("private:20000").activeRun?.sessionId !== null,
      3000,
      "active run",
    );

    const response = await request(harness, "/admin/api/prompts/my-agent.md", {
      method: "PUT",
      body: { content: "---\n---\n\nChanged\n" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "agent_config_busy" });
    expect(await readFile(join(harness.promptRoot, "my-agent.md"), "utf8")).toBe("Body\n");

    const sessionId = harness.app.conversations.status("private:20000").activeRun?.sessionId ?? "";
    harness.agent.complete(sessionId);
  });

  it("applies an agent model change to existing live sessions", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(
      join(harness.promptRoot, "my-agent.md"),
      "---\ndescription: Mine\n---\n\nBody\n",
      "utf8",
    );
    harness.app.config.opencode.default_agent = "my-agent";
    await harness.app.conversations.submit(makeIncomingMessage({ text: "hold" }), "demo");
    await waitFor(
      () => harness.app.conversations.status("private:20000").activeRun === null,
      3000,
      "run completion",
    );
    const sessionId = harness.app.conversations.getConversation("private:20000")?.sessionId;

    const response = await request(harness, "/admin/api/prompts/my-agent.md/model", {
      method: "PUT",
      body: { model: "fake/model-b" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reload: { appliedSessions?: number; failedSessions?: number };
    };
    expect(body.reload).toMatchObject({ appliedSessions: 1, failedSessions: 0 });
    expect(harness.agent.switchedModels).toEqual([{ sessionId, model: "fake/model-b" }]);
  });

  it("applies a model edited through the raw prompt editor to live sessions", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(
      join(harness.promptRoot, "my-agent.md"),
      "---\ndescription: Mine\n---\n\nBody\n",
      "utf8",
    );
    harness.app.config.opencode.default_agent = "my-agent";
    await harness.app.conversations.submit(makeIncomingMessage({ text: "hold" }), "demo");
    await waitFor(
      () => harness.app.conversations.status("private:20000").activeRun === null,
      3000,
      "run completion",
    );
    const sessionId = harness.app.conversations.getConversation("private:20000")?.sessionId;

    const response = await request(harness, "/admin/api/prompts/my-agent.md", {
      method: "PUT",
      body: { content: "---\nmodel: fake/model-b\n---\n\nBody\n" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reload: { appliedSessions?: number; failedSessions?: number };
    };
    expect(body.reload).toMatchObject({ appliedSessions: 1, failedSessions: 0 });
    expect(harness.agent.switchedModels).toEqual([{ sessionId, model: "fake/model-b" }]);
  });

  it("marks plugin-managed agents read-only until advanced override", async () => {
    const harness = await startAdminApp();
    await mkdir(harness.promptRoot, { recursive: true });
    await writeFile(
      join(harness.promptRoot, "qq-rp.md"),
      "---\n# managed by @opencode-qq/roleplay; version: 0.4.0\ndescription: RP\n---\n\nRP prompt\n",
      "utf8",
    );

    const list = await request(harness, "/admin/api/prompts");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      prompts: Array<{ name: string; owner: string; managedBy: string | null; editable: boolean }>;
    };
    expect(body.prompts.find((item) => item.name === "qq-rp.md")).toMatchObject({
      owner: "plugin",
      managedBy: "@opencode-qq/roleplay",
      editable: false,
    });

    const rejected = await request(harness, "/admin/api/prompts/qq-rp.md", {
      method: "PUT",
      body: { content: "changed" },
    });
    expect(rejected.status).toBe(409);

    const overridden = await request(harness, "/admin/api/prompts/qq-rp.md", {
      method: "PUT",
      body: { content: "changed", override: true },
    });
    expect(overridden.status).toBe(200);
    expect(((await overridden.json()) as { content: string }).content).toBe("changed");
  });

  it("lists available models for the agents page", async () => {
    const harness = await startAdminApp();
    const models = await request(harness, "/admin/api/models?projectId=demo");
    expect(models.status).toBe(200);
    const modelBody = (await models.json()) as {
      models: Array<{ id: string; capabilities: { input: string[] } }>;
    };
    expect(modelBody.models[0]).toMatchObject({
      id: "fake/model-a",
      capabilities: { input: ["text", "image"] },
    });
  });

  it("returns dashboard data", async () => {
    const harness = await startAdminApp();
    const overview = await request(harness, "/admin/api/overview");
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      status: { status: string };
      config: { projects: number };
    };
    expect(body.config.projects).toBe(1);
    expect(["ok", "degraded"]).toContain(body.status.status);
  });
});
