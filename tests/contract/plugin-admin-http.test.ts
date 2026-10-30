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
import { makeZip } from "../helpers/zip.js";

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
      version: 2,
      server: { port: 0 },
      onebot: { url: "ws://127.0.0.1:3001", access_token: "test" },
      opencode: { service: { mode: "off", base_url: "http://127.0.0.1:1" } },
      storage: {
        database_path: join(root, "bridge.db"),
        inbox_dir: join(root, "inbox"),
        plugins_dir: join(root, "plugins"),
      },
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

async function adminRequest(
  harness: Harness,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string | null;
    cookie?: string | null;
    form?: FormData;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.cookie !== null) headers.cookie = options.cookie ?? harness.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const csrf = options.csrf === undefined ? harness.csrf : options.csrf;
  if (csrf !== null && (options.method ?? "GET") !== "GET") {
    headers["x-csrf-token"] = csrf;
  }
  return fetch(`${harness.baseUrl}/admin/api${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.form !== undefined
      ? { body: options.form }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
}

function pluginZipFile(id: string, version: string): Promise<File> {
  return makeZip([
    {
      path: "package.json",
      data: JSON.stringify({
        name: id,
        version,
        type: "module",
        opencodeQq: {
          id,
          name: "HTTP fixture",
          version,
          apiVersion: 2,
          capabilities: ["commands"],
          entry: "./index.js",
        },
      }),
    },
    { path: "index.js", data: "export default { setup() {} };" },
  ]).then((buffer) => new File([buffer], `${id}-${version}.zip`, { type: "application/zip" }));
}

function previewForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
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

  it("protects the install preview with session, CSRF and file validation", async () => {
    const harness = await startApp();
    const unauthenticated = await adminRequest(harness, "/plugins/install/preview", {
      method: "POST",
      cookie: null,
      form: previewForm(await pluginZipFile("http-fixture", "0.1.0")),
    });
    expect(unauthenticated.status).toBe(401);

    const noCsrf = await adminRequest(harness, "/plugins/install/preview", {
      method: "POST",
      csrf: null,
      form: previewForm(await pluginZipFile("http-fixture", "0.1.0")),
    });
    expect(noCsrf.status).toBe(403);

    const missingFile = await adminRequest(harness, "/plugins/install/preview", {
      method: "POST",
      form: new FormData(),
    });
    expect(missingFile.status).toBe(400);
    expect(await missingFile.json()).toMatchObject({ error: "missing_file" });
  });

  it("installs, lists and uninstalls a managed ZIP through the HTTP API", async () => {
    const harness = await startApp();
    const id = `http-fixture-${Date.now().toString(36)}`;
    const preview = await adminRequest(harness, "/plugins/install/preview", {
      method: "POST",
      form: previewForm(await pluginZipFile(id, "0.1.0")),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      uploadId: string;
      manifest: { id: string; version: string };
      existing: unknown;
    };
    expect(previewBody).toMatchObject({
      manifest: { id, version: "0.1.0" },
      existing: null,
    });

    const installed = await adminRequest(harness, "/plugins/install", {
      method: "POST",
      body: { uploadId: previewBody.uploadId, enable: true },
    });
    expect(installed.status).toBe(200);
    const installedBody = (await installed.json()) as {
      plugin: { id: string; status: string; managed: boolean };
      install: { managed: boolean; previousVersion: string | null };
    };
    expect(installedBody).toMatchObject({
      plugin: { id, status: "loaded", managed: true },
      install: { managed: true, previousVersion: null },
    });

    const listed = await adminRequest(harness, "/plugins");
    const catalog = (await listed.json()) as {
      plugins: Array<{ id: string; managed: boolean; sourceKind: string }>;
    };
    expect(catalog.plugins.find((plugin) => plugin.id === id)).toMatchObject({
      managed: true,
      sourceKind: "path",
    });

    const rollback = await adminRequest(harness, `/plugins/${id}/rollback`, {
      method: "POST",
    });
    expect(rollback.status).toBe(409);
    expect(await rollback.json()).toMatchObject({ error: "no_backup" });

    const uninstalled = await adminRequest(harness, `/plugins/${id}/uninstall`, {
      method: "POST",
      body: { deleteData: false },
    });
    expect(uninstalled.status).toBe(200);
    expect(await uninstalled.json()).toMatchObject({
      configRemoved: true,
      codeRemoved: true,
      dataDeleted: false,
    });
    expect(await readFile(harness.configPath, "utf8")).not.toContain(id);
  });

  it("rejects a ZIP over the service size limit", async () => {
    const harness = await startApp();
    const oversized = new File([Buffer.alloc(21 * 1024 * 1024)], "oversized.zip", {
      type: "application/zip",
    });
    const response = await adminRequest(harness, "/plugins/install/preview", {
      method: "POST",
      form: previewForm(oversized),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "plugin_archive_too_large" });
  });

  it("reports connection status and updates NapCat env values without exposing secrets", async () => {
    const harness = await startApp();
    const before = await adminRequest(harness, "/connections");
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      envHash: string | null;
      envPath: string;
      napcat: {
        url: string;
        tokenConfigured: boolean;
        status: { connected: boolean; loginOk: boolean | null };
      };
    };
    expect(beforeBody.envPath).toBe(join(harness.configPath, "..", ".env"));
    expect(beforeBody.napcat).toMatchObject({
      url: "ws://127.0.0.1:3001",
      tokenConfigured: true,
      status: { connected: true, loginOk: true },
    });
    expect(JSON.stringify(beforeBody)).not.toMatch(/accessToken|token"|secret/i);

    const updated = await adminRequest(harness, "/connections/napcat", {
      method: "PUT",
      body: {
        url: "ws://127.0.0.1:3002",
        accessToken: "new-napcat-secret",
        expectedEnvHash: beforeBody.envHash,
      },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      napcat: { url: string; tokenConfigured: boolean };
      restartRequired: string[];
      warnings: string[];
    };
    expect(updatedBody.napcat).toMatchObject({
      url: "ws://127.0.0.1:3002",
      tokenConfigured: true,
    });
    expect(updatedBody.restartRequired).toContain("onebot");
    expect(JSON.stringify(updatedBody)).not.toContain("new-napcat-secret");
    expect(await readFile(join(harness.configPath, "..", ".env"), "utf8")).toContain(
      "NAPCAT_ACCESS_TOKEN=new-napcat-secret",
    );
    expect(await readFile(harness.configPath, "utf8")).toContain("NAPCAT_WS_URL");

    const invalid = await adminRequest(harness, "/connections/napcat", {
      method: "PUT",
      body: { url: "http://127.0.0.1:3001" },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_napcat_url" });
  });
});
