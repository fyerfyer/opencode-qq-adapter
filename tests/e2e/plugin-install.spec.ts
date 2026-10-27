import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { makeZip, type ZipEntryInput } from "../helpers/zip.js";

const PASSWORD = "webui-test-password";
const HELLO_FIXTURE = resolve("tests/fixtures/plugins/hello");

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  const password = page.getByRole("textbox", { name: "管理员密码" });
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD);
    await page.getByRole("button", { name: "进入管理台" }).click();
  }
  await expect(page.getByRole("link", { name: "插件" })).toBeVisible();
}

function uniquePluginId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface PluginPackageInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  capabilities?: string[];
  iframe?: boolean;
}

function pluginEntry(input: PluginPackageInput): string {
  const setup =
    input.iframe === true
      ? [
          "    context.admin.page({",
          '      id: "embedded",',
          `      title: ${JSON.stringify(input.name)},`,
          '      kind: "iframe",',
          '      entry: "index.html",',
          "    });",
        ]
      : [];
  return ["export default {", "  setup(context) {", ...setup, "  },", "};"].join("\n");
}

async function makePluginZip(input: PluginPackageInput): Promise<Buffer> {
  const manifest = {
    id: input.id,
    name: input.name,
    version: input.version,
    apiVersion: 1,
    ...(input.description === undefined ? {} : { description: input.description }),
    capabilities: input.capabilities ?? [],
    ...(input.iframe === true ? { ui: { root: "ui", entry: "index.html" } } : {}),
    entry: "./index.js",
  };
  const entries: ZipEntryInput[] = [
    {
      path: "package.json",
      data: JSON.stringify(
        {
          name: `@e2e/${input.id}`,
          version: input.version,
          type: "module",
          opencodeQq: manifest,
        },
        null,
        2,
      ),
    },
    { path: "index.js", data: pluginEntry(input) },
  ];
  if (input.iframe === true) {
    entries.push({
      path: "ui/index.html",
      data: [
        "<!doctype html>",
        '<html lang="zh-CN">',
        '  <head><meta charset="utf-8" /><title>E2E Iframe</title></head>',
        "  <body><main><h1>E2E iframe ready</h1></main></body>",
        "</html>",
      ].join("\n"),
    });
  }
  return makeZip(entries);
}

/** Rewrite a ZIP entry name in both the local header and central directory. */
function renameZipEntry(buffer: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error("replacement entry name must have the same byte length");
  }
  const result = Buffer.from(buffer);
  let offset = result.indexOf(from);
  while (offset !== -1) {
    result.write(to, offset, "utf8");
    offset = result.indexOf(from, offset + Buffer.byteLength(to));
  }
  return result;
}

async function openInstallDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "安装插件" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "安装插件" })).toBeVisible();
  return dialog;
}

async function uploadZip(dialog: Locator, name: string, buffer: Buffer): Promise<void> {
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "application/zip", buffer });
}

async function finishInstall(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toBeHidden();
}

function pluginCard(page: Page, name: string): Locator {
  return page
    .locator('div.rounded-xl[class*="bg-background/60"]')
    .filter({ has: page.getByRole("button", { name: `${name} 更多操作` }) });
}

async function closeUninstallDialog(dialog: Locator): Promise<void> {
  const warning = dialog.getByText("卸载警告");
  await expect
    .poll(
      async () => {
        if (!(await dialog.isVisible().catch(() => false))) return "closed";
        if (await warning.isVisible().catch(() => false)) return "warning";
        return "pending";
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending");
  if (await warning.isVisible().catch(() => false)) {
    await expect(warning).toBeVisible();
    await dialog.getByRole("button", { name: "完成" }).click();
  }
  await expect(dialog).toBeHidden();
}

async function uninstallPlugin(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `${name} 更多操作` }).click();
  await page.getByRole("menuitem", { name: "卸载" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `卸载插件 · ${name}` })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "同时删除插件数据" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "卸载", exact: true }).click();
  await closeUninstallDialog(dialog);
  await expect(pluginCard(page, name)).toHaveCount(0);
}

test("managed ZIP install, update, rollback and uninstall", async ({ page }) => {
  const id = uniquePluginId("e2e-managed");
  const name = "E2E Managed";

  await login(page);
  await page.goto("/admin/plugins");

  let dialog = await openInstallDialog(page);
  await uploadZip(
    dialog,
    "e2e-managed-0.1.0.zip",
    await makePluginZip({ id, name, version: "0.1.0", description: "Managed install fixture" }),
  );
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await expect(dialog.getByText("v0.1.0", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "安装并启用" }).click();
  await expect(dialog.getByText("安装完成，插件已加载")).toBeVisible();
  await finishInstall(dialog);

  const card = pluginCard(page, name);
  await expect(card).toBeVisible();
  await expect(card.getByText("v0.1.0", { exact: true })).toBeVisible();
  await expect(card.getByText("WebUI 托管", { exact: true })).toBeVisible();
  await expect(card.getByText("已加载", { exact: true })).toBeVisible();

  dialog = await openInstallDialog(page);
  await uploadZip(
    dialog,
    "e2e-managed-0.2.0.zip",
    await makePluginZip({ id, name, version: "0.2.0", description: "Managed install fixture" }),
  );
  await expect(
    dialog.getByText("该 ID 已安装 v0.1.0，将更新到 v0.2.0 并保留上一版本。"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "安装并启用" }).click();
  await expect(dialog.getByText("安装完成，插件已加载")).toBeVisible();
  await finishInstall(dialog);
  await expect(card.getByText("v0.2.0", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: `${name} 更多操作` }).click();
  await page.getByRole("menuitem", { name: "回滚到上一版本" }).click();
  await expect(card.getByText("v0.1.0", { exact: true })).toBeVisible();

  await uninstallPlugin(page, name);
});

test("local directory registration reloads code and uninstalls", async ({ page }) => {
  const name = "Hello fixture";

  await login(page);
  await page.goto("/admin/plugins");

  const dialog = await openInstallDialog(page);
  await dialog.getByRole("tab", { name: "本地目录" }).click();
  await dialog.getByLabel("插件目录").fill(HELLO_FIXTURE);
  await dialog.getByRole("button", { name: "检查" }).click();
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await expect(dialog.getByText("hello-fixture", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "安装并启用" }).click();
  await expect(dialog.getByText("安装完成，插件已加载")).toBeVisible();
  await finishInstall(dialog);

  const card = pluginCard(page, name);
  await expect(card).toBeVisible();
  await expect(card.getByText("本地目录", { exact: true })).toBeVisible();
  await expect(card.getByText("已加载", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: `${name} 更多操作` }).click();
  await page.getByRole("menuitem", { name: "重新加载代码" }).click();
  await expect(page.getByText(/代码已重新加载/).first()).toBeVisible();

  await uninstallPlugin(page, name);
});

test("malicious ZIP with path traversal is rejected", async ({ page }) => {
  const id = uniquePluginId("e2e-unsafe");
  const name = "E2E Unsafe";
  const manifest = {
    id,
    name,
    version: "0.1.0",
    apiVersion: 1,
    capabilities: [],
    entry: "./index.js",
  };
  const baseZip = await makeZip([
    {
      path: "package.json",
      data: JSON.stringify({
        name: `@e2e/${id}`,
        version: "0.1.0",
        type: "module",
        opencodeQq: manifest,
      }),
    },
    { path: "index.js", data: "export default { setup() {} };" },
    { path: "aa/escape.txt", data: "escape" },
  ]);
  const traversalZip = renameZipEntry(baseZip, "aa/escape.txt", "../escape.txt");

  await login(page);
  await page.goto("/admin/plugins");

  const dialog = await openInstallDialog(page);
  await uploadZip(dialog, "e2e-unsafe-0.1.0.zip", traversalZip);
  await expect(dialog.locator("p.text-destructive")).toContainText(
    /unsafe|traversal|路径|invalid relative path|invalid characters/i,
  );
  await expect(dialog.getByRole("button", { name: "安装并启用" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: `${name} 更多操作` })).toHaveCount(0);
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  await expect(page.getByText(id, { exact: true })).toHaveCount(0);
});

test("installed iframe page is served from plugin assets", async ({ page }) => {
  const id = uniquePluginId("e2e-iframe");
  const name = "E2E Iframe";

  await login(page);
  await page.goto("/admin/plugins");

  const dialog = await openInstallDialog(page);
  await uploadZip(
    dialog,
    "e2e-iframe-0.1.0.zip",
    await makePluginZip({
      id,
      name,
      version: "0.1.0",
      description: "Iframe install fixture",
      capabilities: ["admin"],
      iframe: true,
    }),
  );
  await expect(dialog.getByText("iframe UI", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "安装并启用" }).click();
  await expect(dialog.getByText("安装完成，插件已加载")).toBeVisible();
  await dialog.getByRole("link", { name: "查看插件页" }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/plugins/${id}/embedded$`));
  const iframe = page.locator(`iframe[title^="${name}"]`);
  await expect(iframe).toHaveAttribute("src", /\/admin\/plugin-assets\//);
  const frame = page.frameLocator(`iframe[title^="${name}"]`);
  await expect(frame.getByText("E2E iframe ready")).toBeVisible({ timeout: 20_000 });

  await page.goto("/admin/plugins");
  await uninstallPlugin(page, name);
});
