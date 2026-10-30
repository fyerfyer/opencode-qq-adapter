import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AuditTrail } from "../../src/observability/audit.js";
import { buildLogger } from "../../src/observability/logger.js";
import { PluginHost } from "../../src/plugins/host.js";
import { MessageSender } from "../../src/qq/sender.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { FakeOneBot, makeTestConfig } from "../helpers/fakes.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}`, import.meta.url));

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  disposers.length = 0;
});

async function makeHost(
  plugins: Record<string, { enabled?: boolean; path: string; options?: Record<string, unknown> }>,
) {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-admin-"));
  const config = makeTestConfig({ projectPath: root });
  config.storage.plugins_dir = join(root, "plugins");
  config.plugins = Object.fromEntries(
    Object.entries(plugins).map(([id, plugin]) => [
      id,
      {
        enabled: plugin.enabled ?? true,
        path: plugin.path,
        options: plugin.options ?? {},
      },
    ]),
  );
  const store = new SqliteStore(":memory:");
  const onebot = new FakeOneBot();
  const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "silent" } });
  const sender = new MessageSender(onebot, config.qq, logger);
  const audit = new AuditTrail(store, logger);
  const host = new PluginHost({
    config,
    logger,
    audit,
    sender,
    conversations: { getConversation: () => null },
    reservedCommands: ["ping", "help"],
    coreVersion: "0.2.0",
  });
  await host.start();
  disposers.push(async () => {
    await host.stop();
    store.close();
    logger.flush?.();
  });
  return { host, onebot, config, root };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1/admin/api/plugins/admin-fixture${path}`, init);
}

describe("PluginHost admin API", () => {
  it("dispatches JSON routes with params, query, actor and plugin options", async () => {
    const { host } = await makeHost({
      "admin-fixture": { path: fixture("admin"), options: { greeting: "hi" } },
    });

    const ping = await host.dispatchAdmin("admin-fixture", request("/ping?x=42"), "/ping", {
      username: "admin",
    });
    expect(ping).toMatchObject({
      ok: true,
      value: "42",
      actor: "admin",
      greeting: "hi",
    });

    const item = await host.dispatchAdmin("admin-fixture", request("/items/abc"), "/items/abc", {
      username: "admin",
    });
    expect(item).toEqual({ id: "abc" });

    const child = await host.dispatchAdmin(
      "admin-fixture",
      request("/items/abc/children/def"),
      "/items/abc/children/def",
      { username: "admin" },
    );
    expect(child).toEqual({ id: "abc", childId: "def" });
  });

  it("reads request bodies and passes through Response objects", async () => {
    const { host } = await makeHost({ "admin-fixture": { path: fixture("admin") } });

    const echo = await host.dispatchAdmin(
      "admin-fixture",
      request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
      "/echo",
      { username: "admin" },
    );
    expect(echo).toEqual({ body: { hello: "world" } });

    const image = await host.dispatchAdmin("admin-fixture", request("/image"), "/image", {
      username: "admin",
    });
    expect(image).toBeInstanceOf(Response);
    const response = image as Response;
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("returns null for unknown routes and rejects plugins without the admin capability", async () => {
    const { host } = await makeHost({
      "admin-fixture": { path: fixture("admin") },
      "hello-fixture": { path: fixture("hello") },
    });

    expect(
      await host.dispatchAdmin("admin-fixture", request("/missing"), "/missing", {
        username: "admin",
      }),
    ).toBeNull();

    await expect(
      host.dispatchAdmin("hello-fixture", request("/ping"), "/ping", { username: "admin" }),
    ).rejects.toThrow(/admin/);
  });

  it("exposes admin pages and validates plugin options", async () => {
    const { host } = await makeHost({
      "admin-fixture": { path: fixture("admin"), options: { greeting: "hi" } },
    });
    const status = host.status().plugins[0];
    expect(status?.admin).toMatchObject({
      routes: 5,
      pages: [{ id: "admin-fixture", title: "Admin fixture", path: "/admin-fixture" }],
    });

    expect(host.validateOptions("admin-fixture", { greeting: "hello" })).toEqual({
      greeting: "hello",
    });
    expect(() => host.validateOptions("admin-fixture", { greeting: "" })).toThrow(/required/);
  });
});
