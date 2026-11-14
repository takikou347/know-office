import { defineConfig, devices } from "@playwright/test";

// 画面を本物のブラウザで開いて確かめる。手元の入口 (workerd) を起こし、Chrome と Safari の 3 つの幅で見る
const port = 5174;

const widths = [
  { name: "phone", viewport: { width: 360, height: 780 } },
  { name: "tablet", viewport: { width: 1024, height: 768 } },
  { name: "desktop", viewport: { width: 1280, height: 800 } },
] as const;

// 入れてあるブラウザが版と合わない所では、PW_CHROMIUM_PATH で Chrome の場所を、E2E_BROWSERS で走らせる物を絞る
const chromiumPath = process.env["PW_CHROMIUM_PATH"];
const only = process.env["E2E_BROWSERS"]?.split(",");
// CI では両方の逃げ道を使わず、Chrome と Safari の全部を走らせる
if (process.env["CI"] && (chromiumPath !== undefined || only !== undefined)) {
  throw new Error("CI では PW_CHROMIUM_PATH と E2E_BROWSERS を使わない");
}

const browsers = [
  {
    name: "chrome",
    use: {
      ...devices["Desktop Chrome"],
      ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
  },
  { name: "safari", use: devices["Desktop Safari"] },
];
const unknown = only?.filter((name) => !browsers.some((b) => b.name === name)) ?? [];
if (unknown.length > 0) throw new Error(`E2E_BROWSERS に知らない名前がある: ${unknown.join(",")}`);
const chosen = browsers.filter((b) => !only || only.includes(b.name));

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "off" },
  projects: chosen.flatMap((b) =>
    widths.map((w) => ({
      name: `${b.name}-${w.name}`,
      use: { ...b.use, viewport: w.viewport },
    })),
  ),
  webServer: {
    command: `pnpm run dev --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
