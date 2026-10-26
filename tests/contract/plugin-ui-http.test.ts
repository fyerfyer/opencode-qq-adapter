import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  cookie: string;
}

async function startApp(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-ui-http-"));
  const projectPath = join(root, "project");
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
        demo: { path: projectPath, policy: "standard", allowed_users: ["20000"] },
      },
      policies: { standard: { read: "allow", edit: "ask", shell: "ask" } },
      plugins: { "ui-fixture": { path: fixture("ui") } },
      admin: { enabled: true },
    }),
    "utf8",
  );

  const loaded = await loadConfig(configPath, { checkPaths: true });
  const config = loaded.config;
  config.server.port = 0;
  const store = new SqliteStore(":memory:");
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const app = new App(config, {
    logger,
    store,
    agent: new FakeAgent(),
    onebot: new FakeOneBot(),
    configPath,
    adminPassword: ADMIN_PASSWORD,
    promptRoot: join(root, "prompts"),
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
  return { baseUrl, cookie };
}

describe("plugin UI HTTP surface", () => {
  it("returns a signed iframe descriptor and serves assets without cookies", async () => {
    const harness = await startApp();
    const descriptor = await fetch(`${harness.baseUrl}/admin/api/plugins/ui-fixture/ui`, {
      headers: { cookie: harness.cookie },
    });
    expect(descriptor.status).toBe(200);
    const page = (await descriptor.json()) as {
      url: string;
      pageId: string;
      entry: string;
      protocol: number;
    };
    expect(page).toMatchObject({ pageId: "overview", entry: "index.html", protocol: 1 });
    expect(page.url).toMatch(/^\/admin\/plugin-assets\/[^/]+\/ui-fixture\/index\.html$/);

    const html = await fetch(`${harness.baseUrl}${page.url}`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("access-control-allow-origin")).toBe("*");
    expect(html.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(html.headers.get("cache-control")).toBe("no-store");
    const csp = html.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(await html.text()).toContain("UI fixture");

    const cssUrl = page.url.replace("index.html", "style.css");
    const css = await fetch(`${harness.baseUrl}${cssUrl}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("access-control-allow-origin")).toBe("*");

    const unauthenticatedDescriptor = await fetch(
      `${harness.baseUrl}/admin/api/plugins/ui-fixture/ui`,
    );
    expect(unauthenticatedDescriptor.status).toBe(401);
  });

  it("rejects invalid tokens, unknown pages and traversal", async () => {
    const harness = await startApp();
    const descriptor = await fetch(`${harness.baseUrl}/admin/api/plugins/ui-fixture/ui/overview`, {
      headers: { cookie: harness.cookie },
    });
    const page = (await descriptor.json()) as { url: string };

    const invalid = await fetch(
      `${harness.baseUrl}${page.url.replace(/\/[^/]+\/ui-fixture\//, "/bad/ui-fixture/")}`,
    );
    expect(invalid.status).toBe(403);

    const traversal = await fetch(
      `${harness.baseUrl}${page.url.replace("index.html", "%2e%2e%2fpackage.json")}`,
    );
    expect(traversal.status).toBe(404);

    const missingPage = await fetch(`${harness.baseUrl}/admin/api/plugins/ui-fixture/ui/unknown`, {
      headers: { cookie: harness.cookie },
    });
    expect(missingPage.status).toBe(404);
  });
});
