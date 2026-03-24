import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 300_000,
  use: {
    headless: false,
    viewport: { width: 1400, height: 900 },
  },
});
