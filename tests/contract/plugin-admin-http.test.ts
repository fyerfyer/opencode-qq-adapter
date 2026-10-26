import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { App } from "../../src/app.js";
import { loadConfig } from "../../src/config/loader.js";
import { buildLogger } from "../../src/observability/logger.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeAgent, FakeOneBot } from "../helpers/fakes.js";

const ADMIN_PASSWORD = "test-admin-password";
const disposers: Array<() => Promise<void>> = [];
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}`, import.meta.url));

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

interface Harness {
  baseUrl: string;
  configPath: string;
  cookie: string;
  csrf: string;
}

async function startApp(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-admin-http-"));
  const projectPath = join(root, "project");
  const promptRoot = join(root, "prompts");
  const configPath = join(root, "config.yaml");
  await mkdir(projectPath, { recursive: true });
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
        plugins_dir: join(root, "plugins"),
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
      plugins: {
        "admin-fixture": {
          path: fixture("admin"),
          options: { greeting: "admin-hello" },
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
  return { baseUrl, configPath, cookie, csrf: body.csrfToken };
}

async function request(
  harness: Harness,
  path: string,
  options: { method?: string; body?: unknown; csrf?: string | null } = {},
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
  return fetch(`${harness.baseUrl}/admin/api/plugins/admin-fixture${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("Plugin admin HTTP API", () => {
  it("requires a session and dispatches admin routes", async () => {
    const harness = await startApp();
    const unauthenticated = await fetch(`${harness.baseUrl}/admin/api/plugins/admin-fixture/ping`);
    expect(unauthenticated.status).toBe(401);

    const ping = await request(harness, "/ping?x=1");
    expect(ping.status).toBe(200);
    expect(await ping.json()).toMatchObject({ ok: true, value: "1", greeting: "admin-hello" });

    const missing = await request(harness, "/missing");
    expect(missing.status).toBe(404);

    const image = await request(harness, "/image");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("requires CSRF for plugin writes", async () => {
    const harness = await startApp();
    const rejected = await request(harness, "/echo", {
      method: "POST",
      body: { hello: "world" },
      csrf: null,
    });
    expect(rejected.status).toBe(403);

    const accepted = await request(harness, "/echo", {
      method: "POST",
      body: { hello: "world" },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ body: { hello: "world" } });
  });

  it("reads and updates plugin options with config hash protection", async () => {
    const harness = await startApp();
    const options = await request(harness, "/options");
    expect(options.status).toBe(200);
    const snapshot = (await options.json()) as {
      options: { greeting: string };
      configHash: string;
      plugin: { id: string; status: string };
    };
    expect(snapshot.options.greeting).toBe("admin-hello");
    expect(snapshot.plugin).toMatchObject({ id: "admin-fixture", status: "loaded" });

    const invalid = await request(harness, "/options", {
      method: "PUT",
      body: { options: { greeting: "" }, expectedHash: snapshot.configHash },
    });
    expect(invalid.status).toBe(400);
    expect(await readFile(harness.configPath, "utf8")).toContain("greeting: admin-hello");

    const saved = await request(harness, "/options", {
      method: "PUT",
      body: { options: { greeting: "updated" }, expectedHash: snapshot.configHash },
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as {
      options: { greeting: string };
      configHash: string;
      reload: { ok: boolean };
    };
    expect(savedBody.options.greeting).toBe("updated");
    expect(savedBody.reload.ok).toBe(true);
    expect(await readFile(harness.configPath, "utf8")).toContain("greeting: updated");

    const stale = await request(harness, "/options", {
      method: "PUT",
      body: { options: { greeting: "stale" }, expectedHash: snapshot.configHash },
    });
    expect(stale.status).toBe(409);
  });

  it("returns 404 for an unknown plugin", async () => {
    const harness = await startApp();
    const response = await fetch(`${harness.baseUrl}/admin/api/plugins/nope/options`, {
      headers: { cookie: harness.cookie },
    });
    expect(response.status).toBe(404);
  });

  it("enables and disables a plugin through the UI API", async () => {
    const harness = await startApp();
    const options = await request(harness, "/options");
    const snapshot = (await options.json()) as { configHash: string };

    const disabled = await request(harness, "/enabled", {
      method: "PUT",
      body: { enabled: false, expectedHash: snapshot.configHash },
    });
    expect(disabled.status).toBe(200);
    const disabledBody = (await disabled.json()) as { plugin: { status: string } };
    expect(disabledBody.plugin.status).toBe("disabled");
    expect(await readFile(harness.configPath, "utf8")).toContain("enabled: false");

    const listed = await fetch(`${harness.baseUrl}/admin/api/plugins`, {
      headers: { cookie: harness.cookie },
    });
    const status = (await listed.json()) as { plugins: Array<{ status: string }> };
    expect(status.plugins[0]?.status).toBe("disabled");
  });
});
