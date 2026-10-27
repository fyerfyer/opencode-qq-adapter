import { expect, type Page, test } from "@playwright/test";

const PASSWORD = "webui-test-password";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  const password = page.getByRole("textbox", { name: "管理员密码" });
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD);
    await page.getByRole("button", { name: "进入管理台" }).click();
  }
  await expect(page.getByRole("link", { name: "插件" })).toBeVisible();
}

test("third-party iframe uses the bridge and is isolated from the admin page", async ({ page }) => {
  await login(page);
  await page.goto("/admin/plugins/ui-fixture/overview");

  const frame = page.frameLocator('iframe[title^="UI fixture"]');
  await expect(frame.getByText(/bridge connected: ui-fixture/)).toBeVisible({ timeout: 20_000 });

  await frame.getByRole("button", { name: "调用插件 API" }).click();
  await expect(frame.locator("#status")).toContainText('"ok":true');

  await frame.getByRole("button", { name: "显示 toast" }).click();
  await expect(page.getByText("来自 UI fixture").first()).toBeVisible();

  await frame.getByRole("button", { name: "核心 confirm" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("fixture confirmed").first()).toBeVisible();

  await frame.getByRole("button", { name: "尝试越权路径" }).click();
  await expect(frame.locator("#status")).toContainText("escape blocked");

  const iframe = page.locator('iframe[title^="UI fixture"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-downloads");

  const target = page.frames().find((item) => item.url().includes("/admin/plugin-assets/"));
  expect(target).toBeTruthy();
  const isolation = await target?.evaluate(() => {
    let parentAccess = "";
    let storage = "";
    try {
      parentAccess = window.parent.document.title;
    } catch (error) {
      parentAccess = error instanceof Error ? error.name : String(error);
    }
    try {
      storage = String(window.localStorage.length);
    } catch (error) {
      storage = error instanceof Error ? error.name : String(error);
    }
    return { parentAccess, storage, origin: location.origin };
  });
  expect(isolation).toMatchObject({
    parentAccess: "SecurityError",
    storage: "SecurityError",
  });

  const before = await target?.evaluate(() => document.documentElement.classList.contains("dark"));
  await page.getByRole("button", { name: "切换主题" }).click();
  await expect
    .poll(() =>
      target?.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        background: getComputedStyle(document.documentElement)
          .getPropertyValue("--background")
          .trim(),
      })),
    )
    .toMatchObject({ dark: !before });
});

test("session page switches the current agent and model", async ({ page }) => {
  await login(page);
  await page.goto("/admin/sessions");
  const row = page.getByRole("row").filter({ hasText: "private:20000" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "切换 Agent / 模型" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Fake Model B/ }).click();
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: /Build/ }).click();
  await dialog.getByRole("button", { name: "保存并切换" }).click();
  await expect(page.getByText("已切换当前会话的 Agent / 模型").first()).toBeVisible();
  await expect(row.getByText("build · fake/model-b")).toBeVisible();
});

test("plugin options dialog loads the YAML options as JSON", async ({ page }) => {
  await login(page);
  await page.goto("/admin/plugins");
  await page.getByRole("button", { name: "配置" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveValue(/\{/);
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
});

test("example plugin uses bridge JSON routes and core navigation", async ({ page }) => {
  await login(page);
  await page.goto("/admin/plugins/ui-demo");
  const frame = page.frameLocator('iframe[title^="UI Demo"]');
  await expect(frame.getByText("bridge 已连接")).toBeVisible({ timeout: 20_000 });

  await frame.getByPlaceholder("写一条只在插件内存里的记录").fill("来自 Playwright");
  await frame.getByRole("button", { name: "添加" }).click();
  await expect(frame.getByText("来自 Playwright")).toBeVisible();

  await frame.getByRole("button", { name: "返回插件页" }).click();
  await expect(page).toHaveURL(/\/admin\/plugins$/);
});

test("roleplay iframe loads, edits worldbook and renders bridge-backed images", async ({
  page,
}) => {
  await login(page);
  await page.goto("/admin/plugins/roleplay");

  const frame = page.frameLocator('iframe[title^="Roleplay"]');
  await expect(frame.getByRole("tab", { name: "概览" })).toBeVisible({ timeout: 25_000 });
  await expect(frame.getByText("角色卡、世界书、表情包", { exact: false })).toBeVisible();

  await frame.getByRole("tab", { name: "角色" }).click();
  await frame
    .getByRole("button", { name: /蓝色大肥鱼/ })
    .first()
    .click();
  await frame.getByRole("tab", { name: "世界书" }).click();
  await expect(frame.getByText("5 条")).toBeVisible();

  await frame.getByRole("button", { name: "新增条目" }).click();
  const dialog = frame.locator('[role="dialog"]').nth(1);
  await dialog.locator("input").nth(0).fill("E2E 条目");
  await dialog.locator("textarea").nth(0).fill("e2e, 测试");
  await dialog.locator("textarea").nth(2).fill("E2E 写入的世界书内容。");
  await frame.getByRole("button", { name: "应用到列表" }).click();
  await frame.getByRole("button", { name: "保存" }).first().click();
  await expect(page.getByText(/世界书已保存/).first()).toBeVisible();
  await expect(frame.getByText("E2E 条目")).toBeVisible();

  const worldbook = await page.evaluate(async () => {
    const response = await fetch("/admin/api/plugins/roleplay/personas/blue-fat-fish/worldbook");
    return (await response.json()) as { entries: Array<{ name: string; content: string }> };
  });
  expect(worldbook.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "E2E 条目", content: "E2E 写入的世界书内容。" }),
    ]),
  );

  await frame.getByRole("button", { name: "关闭" }).first().click();
  await frame.getByRole("tab", { name: "表情包" }).click();
  const image = frame.locator("img").first();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test("settings connections shows NapCat status and Jev secret management", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settings");
  await page.getByRole("tab", { name: "连接" }).click();

  await expect(page.getByText("NapCat", { exact: true })).toBeVisible();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByLabel("NapCat WebSocket URL")).toHaveValue("ws://127.0.0.1:1");
  await expect(page.getByText("Jev / Roleplay", { exact: true })).toBeVisible();
  await expect(page.getByText("JEV_API_KEY", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存连接配置" })).toBeVisible();

  await page.getByLabel("NapCat WebSocket URL").fill("ws://127.0.0.1:3002");
  await page.getByLabel("NapCat Access Token").fill("e2e-napcat-token");
  await page.getByRole("button", { name: "保存连接配置" }).click();
  await expect(page.getByText(/需要重启 bridge：onebot/)).toBeVisible();
  await expect(page.getByText(/NapCat URL\/Token 已保存/)).toBeVisible();
  await expect(page.getByLabel("NapCat Access Token")).toHaveValue("");
});
