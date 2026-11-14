import { defineConfig, devices } from "@playwright/test";

// 画面を本物のブラウザで開いて確かめる。手元の入口 (workerd) を起こし、Chrome と Safari の 3 つの幅で見る
const port = 5174;

const widths = [
  { name: "phone", viewport: { width: 360, height: 780 } },
  { name: "tablet", viewport: { width: 820, height: 1180 } },
  { name: "desktop", viewport: { width: 1440, height: 900 } },
] as const;

const browsers = [
  { name: "chrome", use: devices["Desktop Chrome"] },
  { name: "safari", use: devices["Desktop Safari"] },
] as const;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "off" },
  projects: browsers.flatMap((b) =>
    widths.map((w) => ({
      name: `${b.name}-${w.name}`,
      use: { ...b.use, viewport: w.viewport },
    })),
  ),
  webServer: {
    command: `vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
