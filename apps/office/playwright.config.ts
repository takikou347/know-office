import { defineConfig, devices } from "@playwright/test";

// 画面を本物のブラウザで開いて確かめる。手元の入口 (workerd) を起こし、Chrome と Safari の 3 つの幅で見る
const port = 5174;

const widths = [
  { name: "phone", viewport: { width: 360, height: 780 } },
  { name: "tablet", viewport: { width: 820, height: 1180 } },
  { name: "desktop", viewport: { width: 1440, height: 900 } },
] as const;

// 入れてあるブラウザが版と合わない所では、PW_CHROMIUM_PATH で Chrome の場所を、E2E_BROWSERS で走らせる物を絞る
const chromiumPath = process.env["PW_CHROMIUM_PATH"];
const only = process.env["E2E_BROWSERS"]?.split(",");

const browsers = [
  {
    name: "chrome",
    use: {
      ...devices["Desktop Chrome"],
      ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
  },
  { name: "safari", use: devices["Desktop Safari"] },
].filter((b) => !only || only.includes(b.name));

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
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
