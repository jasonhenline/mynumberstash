import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { browserName: "chromium" },
  projects: [
    {
      name: "local",
      testMatch: "game.spec.ts",
      use: { baseURL: "http://localhost:5173" },
    },
    {
      name: "production",
      testMatch: "production.spec.ts",
      use: { baseURL: "http://localhost:5174" },
    },
  ],
  webServer: [{
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  }, {
    command: "pnpm build && pnpm preview",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
  }],
});
