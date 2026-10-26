import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8791",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "WEBUI_FIXTURE_PORT=8791 WEBUI_FIXTURE_PASSWORD=webui-test-password pnpm tsx scripts/webui-fixture.ts",
    url: "http://127.0.0.1:8791/admin",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
