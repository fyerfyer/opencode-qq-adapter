#!/usr/bin/env tsx
/**
 * Start an isolated admin WebUI fixture with the real Roleplay plugin, a
 * temporary database and a known password. Used for manual Playwright smoke
 * tests; never touches the production bridge data.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { BindingStore } from "../packages/roleplay/src/bindings.js";
import { MemoryDocumentStore } from "../packages/roleplay/src/memory-document.js";
import { importCard } from "../packages/roleplay/src/persona.js";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config/loader.js";
import { buildLogger } from "../src/observability/logger.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { FakeAgent, FakeOneBot } from "../tests/helpers/fakes.js";

const root = await mkdtemp(join(tmpdir(), "opencode-qq-webui-"));
const dataDir = join(root, "data");
const projectPath = join(root, "project");
const personasDir = join(dataDir, "plugins", "roleplay", "personas");
const configPath = join(root, "config.yaml");
const promptRoot = join(root, "prompts");
const password = process.env.WEBUI_FIXTURE_PASSWORD ?? "webui-test-password";
const roleplayPath = resolve("packages/roleplay");
const uiFixturePath = resolve("tests/fixtures/plugins/ui");
const uiDemoPath = resolve("examples/ui-plugin");
await Promise.all([
  copyFile(
    resolve("packages/plugin-ui/dist/index.js"),
    resolve("tests/fixtures/plugins/ui/ui/sdk.js"),
  ),
  copyFile(resolve("packages/plugin-ui/dist/index.js"), resolve("examples/ui-plugin/ui/sdk.js")),
]);

await mkdir(projectPath, { recursive: true });
await mkdir(personasDir, { recursive: true });
await mkdir(promptRoot, { recursive: true });
await writeFile(
  join(promptRoot, "qq-code.md"),
  "---\n# managed by opencode-qq-adapter\ndescription: QQ coding agent\nmode: primary\n---\n\nKeep replies concise.\n",
  "utf8",
);
await writeFile(
  join(promptRoot, "qq-rp.md"),
  "---\n# managed by @opencode-qq/roleplay; version: 0.4.0\ndescription: QQ roleplay engine\nmode: primary\n---\n\nRoleplay engine prompt.\n",
  "utf8",
);
await writeFile(
  join(promptRoot, "qq-rp-utility.md"),
  "---\n# managed by @opencode-qq/roleplay; version: 0.4.0\ndescription: QQ roleplay memory worker\nmode: primary\n---\n\nReturn JSON only.\n",
  "utf8",
);
await importCard({
  sourcePath: resolve("tests/fixtures/roleplay/blue-fat-fish.card.json"),
  personasDir,
  id: "blue-fat-fish",
  stickerRoot: join(dataDir, "plugins", "roleplay", "stickers"),
});

const stickerDir = join(dataDir, "plugins", "roleplay", "stickers", "blue-fat-fish", "happy");
await mkdir(stickerDir, { recursive: true });
await writeFile(join(stickerDir, "1.png"), await readFile(resolve("tests/fixtures/red.png")));
const sadDir = join(dataDir, "plugins", "roleplay", "stickers", "blue-fat-fish", "sad");
await mkdir(sadDir, { recursive: true });
await writeFile(join(sadDir, "1.png"), await readFile(resolve("tests/fixtures/red.png")));

const memory = new MemoryDocumentStore({
  root: join(dataDir, "plugins", "roleplay", "memory"),
  historyLimit: 20,
});
await memory.writeUser(
  { namespace: "blue-fat-fish", scope: "private:10001", actorQq: 10001 },
  [
    "# 用户记忆",
    "",
    "## 基本信息",
    "- 称呼：鱼片",
    "",
    "## 喜好",
    "- 喜欢吃白米饭",
    "- 讨厌香菜",
    "",
    "## 手动记忆",
    "- 测试记忆",
    "",
  ].join("\n"),
);

const bindings = new BindingStore(join(dataDir, "plugins", "roleplay", "roleplay.db"));
bindings.set({
  chatKey: "private:10001",
  namespace: "blue-fat-fish",
  previousProjectId: "demo",
  enabled: true,
  updatedAt: Date.now(),
});
bindings.close();

const configSource = stringify({
  version: 2,
  server: { host: "127.0.0.1", port: 0 },
  onebot: { url: "ws://127.0.0.1:1", access_token: "fixture" },
  opencode: {
    service: { mode: "off", base_url: "http://127.0.0.1:1" },
    default_agent: null,
  },
  security: {
    allowed_roots: [root],
    rate_limit: {},
    budgets: {},
    admin_2fa: {},
  },
  default_project: "demo",
  users: {
    "20000": { role: "owner", projects: ["*"], write_projects: ["*"] },
  },
  projects: {
    demo: {
      path: projectPath,
      workspace: "shared",
    },
    roleplay: {
      path: personasDir,
      description: "Roleplay personas",
      workspace: "none",
      agent: "qq-rp",
      hidden: true,
      managed_by: "roleplay",
    },
  },
  plugins: {
    "ui-fixture": {
      enabled: true,
      path: uiFixturePath,
    },
    "ui-demo": {
      enabled: true,
      path: uiDemoPath,
    },
    roleplay: {
      enabled: true,
      path: roleplayPath,
      options: {
        project_id: "roleplay",
        agent: "qq-rp",
        install_agent: false,
        personas_dir: personasDir,
        default_persona: "blue-fat-fish",
        fallback_project: "demo",
        memory_refresh_cooldown_ms: 0,
      },
    },
  },
  workspaces: { root: join(dataDir, "workspaces") },
  notifications: { owner_alerts: { enabled: false } },
  admin: { enabled: true, allow_remote: false, session_hours: 12, login_attempts: 20 },
  logging: { level: "warn" },
  features: { images: true, files: true },
  qq: { max_reply_images: 2 },
  storage: {
    database_path: join(dataDir, "opencode-qq.db"),
    inbox_dir: join(dataDir, "inbox"),
    plugins_dir: join(dataDir, "plugins"),
    inbox_ttl_hours: 24,
  },
});
await writeFile(configPath, configSource, "utf8");

const loaded = await loadConfig(configPath, { checkPaths: true });
const config = loaded.config;
const requestedPort = Number(process.env.WEBUI_FIXTURE_PORT ?? "0");
config.server.port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 0;
config.logging.level = "warn";
const store = new SqliteStore(":memory:");
store.conversations.upsert({
  chatKey: "private:20000",
  projectId: "demo",
  workspaceId: null,
  sessionId: null,
  actorQq: 20000,
  agent: null,
  model: null,
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
});
const onebot = new FakeOneBot();
const logger = buildLogger(config, { env: { NODE_ENV: "test", LOG_LEVEL: "warn" } });
const app = new App(config, {
  logger,
  store,
  agent: new FakeAgent(),
  onebot,
  configPath,
  adminPassword: password,
  promptRoot,
});
await app.start();
const url = `http://127.0.0.1:${app.httpPort}/admin`;
console.log(`WEBUI_URL=${url}`);
console.log(`WEBUI_PASSWORD=${password}`);
console.log(`WEBUI_DATA=${root}`);
console.log("Press Ctrl+C to stop.");

const shutdown = async () => {
  await app.stop();
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
