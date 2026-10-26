import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PluginUiTokenSigner } from "../../src/admin/plugin-ui-token.js";
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

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "qq-plugin-ui-"));
  const config = makeTestConfig({ projectPath: root });
  config.storage.plugins_dir = join(root, "plugins");
  config.plugins = {
    "ui-fixture": {
      enabled: true,
      path: fixture("ui"),
      options: {},
    },
  };
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
    coreVersion: "0.1.1",
  });
  await host.start();
  disposers.push(async () => {
    await host.stop();
    store.close();
    logger.flush?.();
  });
  return { host, root };
}

describe("plugin UI pages", () => {
  it("exposes iframe pages and resolves their entry", async () => {
    const { host } = await makeHost();
    const status = host.status().plugins[0];
    expect(status?.admin.pages).toMatchObject([
      {
        id: "overview",
        title: "UI fixture",
        kind: "iframe",
        path: "/plugins/ui-fixture/overview",
        entry: "index.html",
      },
    ]);

    const page = host.adminUiPage("ui-fixture");
    expect(page).toMatchObject({
      page: { id: "overview", kind: "iframe" },
      entry: "index.html",
    });
    expect(page?.root).toContain("tests/fixtures/plugins/ui/ui");

    const asset = await host.resolveAdminUiAsset("ui-fixture", "index.html");
    expect(asset?.contentType).toBe("text/html; charset=utf-8");
    expect(asset?.cacheControl).toBe("no-cache");
  });

  it("rejects traversal and symlink escapes", async () => {
    const { host } = await makeHost();
    expect(await host.resolveAdminUiAsset("ui-fixture", "../package.json")).toBeNull();
    expect(await host.resolveAdminUiAsset("ui-fixture", "/etc/passwd")).toBeNull();

    const linkRoot = await mkdtemp(join(tmpdir(), "qq-plugin-ui-link-"));
    const link = join(fixture("ui"), "ui", "escape.txt");
    await symlink(join(linkRoot, "outside.txt"), link).catch(() => undefined);
    try {
      expect(await host.resolveAdminUiAsset("ui-fixture", "escape.txt")).toBeNull();
    } finally {
      await rm(link, { force: true });
      await rm(linkRoot, { recursive: true, force: true });
    }
  });
});

describe("plugin UI asset token", () => {
  it("signs, verifies and rejects tampered or expired tokens", () => {
    let now = 1_000_000;
    const signer = new PluginUiTokenSigner(new Uint8Array(32).fill(7), {
      ttlMs: 60_000,
      now: () => now,
    });
    const token = signer.sign("roleplay");
    expect(signer.verify(token)).toEqual({ pluginId: "roleplay" });
    expect(signer.verify(`${token}x`)).toBeNull();
    const [payload, signature] = token.split(".") as [string, string];
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
    expect(signer.verify(tampered)).toBeNull();
    now += 60_001;
    expect(signer.verify(token)).toBeNull();
  });
});
