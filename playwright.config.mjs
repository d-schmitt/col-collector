import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { browserName: "chromium", viewport: { width: 1100, height: 900 }, trace: "retain-on-failure" },
});
