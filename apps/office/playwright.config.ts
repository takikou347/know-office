import { defineConfig, devices } from "@playwright/test";
import { LOGIN_PROJECT, sessionState } from "./e2e/helpers/session.ts";

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

/**
 * プロジェクトごとの送信元の IP を返す。手元の入口には CF-Connecting-IP が無く、全部の要求が 1 つの送信元として
 * 1 分 300 回のレート制限に数えられ、Chrome と Safari を並べて流すと 429 で画面が空になったため、ブラウザーと幅ごとに分ける
 * @param index プロジェクトの番号
 * @returns 文書用の範囲 (RFC 5737 の 192.0.2.0/24) の IP
 */
function sourceIp(index: number): string {
  return `192.0.2.${index + 1}`;
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
  use: { baseURL: `http://localhost:${port}`, trace: "off", screenshot: "only-on-failure" },
  projects: [
    // 記録は 1 度だけ置き、ログインセッションはブラウザーごとに作る。クッキーの扱いがブラウザーで違うため
    { name: "records", testMatch: /records\.setup\.ts/ },
    ...chosen.map((b) => ({ name: `${LOGIN_PROJECT}${b.name}`, testMatch: /login\.setup\.ts/, dependencies: ["records"], use: b.use })),
    ...chosen.flatMap((b, i) =>
      widths.map((w, j) => ({
        name: `${b.name}-${w.name}`,
        dependencies: [`${LOGIN_PROJECT}${b.name}`],
        use: { ...b.use, viewport: w.viewport, storageState: sessionState(b.name), extraHTTPHeaders: { "CF-Connecting-IP": sourceIp(i * widths.length + j) } },
      })),
    ),
  ],
  webServer: {
    command: `pnpm run dev --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
