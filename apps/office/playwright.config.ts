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

// 見た目とアクセシビリティの通しは、ブラウザーと幅ごとに回す
const screenProjects = chosen.flatMap((b, i) =>
  widths.map((w, j) => ({
    name: `${b.name}-${w.name}`,
    testIgnore: [/attack\.spec\.ts/, /flows\//],
    dependencies: [`${LOGIN_PROJECT}${b.name}`],
    use: { ...b.use, viewport: w.viewport, storageState: sessionState(b.name), extraHTTPHeaders: { "CF-Connecting-IP": sourceIp(i * widths.length + j) } },
  })),
);

// 利用場面の通し (e2e/flows/) は、本物のゲートウェイの D1 と DO を書き換える。幅ごとに同時に流すと版の 409 と二重の決定になり、
// パスキーの仮想の認証器は Chrome にしか無いので、Chrome の幅 1,280 で 1 本ずつ流す。セッションをすべて切る場面があるので、ほかの通しの後に流す
const chrome = chosen.find((b) => b.name === "chrome");
const flowUse = chrome ? { ...chrome.use, viewport: widths[2].viewport, extraHTTPHeaders: { "CF-Connecting-IP": sourceIp(browsers.length * widths.length) } } : null;
const flowProjects = flowUse
  ? [
      { name: "flows-passkey", testMatch: /flows\/passkey\.setup\.ts/, dependencies: ["attack", ...screenProjects.map((p) => p.name)], teardown: "flows-cleanup", use: flowUse },
      { name: "flows", testMatch: /flows\/.*\.spec\.ts/, dependencies: ["flows-passkey"], fullyParallel: false, workers: 1, use: flowUse },
      { name: "flows-cleanup", testMatch: /flows\/cleanup\.teardown\.ts/, use: flowUse },
    ]
  : [];

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "off", screenshot: "only-on-failure" },
  projects: [
    // 記録は 1 度だけ置き、ログインセッションはブラウザーごとに作る。クッキーの扱いがブラウザーで違うため
    { name: "records", testMatch: /records\.setup\.ts/ },
    // 自動の攻撃のチェックはブラウザーを使わず要求だけを送るので、ブラウザーと幅ごとに回さず 1 度だけ流す。セッションを作るので D1 のマイグレーションの後に流す
    { name: "attack", testMatch: /attack\.spec\.ts/, dependencies: ["records"] },
    ...chosen.map((b) => ({ name: `${LOGIN_PROJECT}${b.name}`, testMatch: /login\.setup\.ts/, dependencies: ["records"], use: b.use })),
    ...screenProjects,
    ...flowProjects,
  ],
  webServer: {
    command: `pnpm run dev --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
