import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { LOGIN_PROJECT, sessionState } from "./e2e/helpers/session.ts";
import { E2E_STATE, PERSIST_ENV } from "./e2e/helpers/state.ts";

// 画面を本物のブラウザで開いて確かめる。手元の入口 (workerd) を起こし、Chrome の幅 1,280 で全部、幅 360 で形の変わる画面を見る。
// Safari は毎回流さず、デプロイの前に Mac で E2E_BROWSERS=safari を付けて 1 度流す
// 待ち受けの番号は E2E_PORT で替え、別の作業ツリーと同時に流せるようにする (scripts/verify.ts が作業ツリーごとに決める)
const port = Number(process.env["E2E_PORT"] ?? "5174");

// 代わりの物 (Access、Claude API、GitHub) は入口の次の番号で待ち受ける。ゲートウェイも e2e/helpers/fakes.ts も .dev.vars から読むので、ここで書く
const devVars = join(import.meta.dirname, ".dev.vars");
if (!existsSync(devVars)) copyFileSync(join(import.meta.dirname, ".dev.vars.example"), devVars);
// 中身が同じ時は書かない。書くと開発サーバーが .dev.vars の変化を見て起こし直し、代わりの物を二重に待ち受けて落ちる
const vars = readFileSync(devVars, "utf8");
const wanted = vars.replace(/^DEV_FAKES_URL=.*$/m, `DEV_FAKES_URL=http://localhost:${port + 1}`);
if (wanted !== vars) writeFileSync(devVars, wanted);

const widths = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, testMatch: undefined },
  // 幅で形の変わる画面 (切り替え、表、オフィス、差分) だけを狭い幅でも見る
  { name: "phone", viewport: { width: 360, height: 780 }, testMatch: /(a11y|screens|review|office)\.spec\.ts/ },
] as const;

// 入れてあるブラウザが版と合わない所では、PW_CHROMIUM_PATH で Chrome の場所を、E2E_BROWSERS で走らせる物を選ぶ
const chromiumPath = process.env["PW_CHROMIUM_PATH"];
const only = process.env["E2E_BROWSERS"]?.split(",") ?? ["chrome"];
// CI では逃げ道を使わず、Chrome を走らせる
if (process.env["CI"] && (chromiumPath !== undefined || process.env["E2E_BROWSERS"] !== undefined)) {
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
const unknown = only.filter((name) => !browsers.some((b) => b.name === name));
if (unknown.length > 0) throw new Error(`E2E_BROWSERS に知らない名前がある: ${unknown.join(",")}`);
const chosen = browsers.filter((b) => only.includes(b.name));

// 見た目とアクセシビリティの通しは、ブラウザーと幅ごとに回す
const screenProjects = chosen.flatMap((b, i) =>
  widths.map((w, j) => ({
    name: `${b.name}-${w.name}`,
    ...(w.testMatch ? { testMatch: w.testMatch } : {}),
    testIgnore: [/attack\.spec\.ts/, /flows\//],
    dependencies: [`${LOGIN_PROJECT}${b.name}`],
    use: { ...b.use, viewport: w.viewport, storageState: sessionState(b.name), extraHTTPHeaders: { "CF-Connecting-IP": sourceIp(i * widths.length + j) } },
  })),
);

// 利用場面の通し (e2e/flows/) は、本物のゲートウェイの D1 と DO を書き換える。幅ごとに同時に流すと版の 409 と二重の決定になり、
// パスキーの仮想の認証器は Chrome にしか無いので、Chrome の幅 1,280 で 1 本ずつ流す。セッションをすべて切る場面があるので、ほかの通しの後に流す
const chrome = chosen.find((b) => b.name === "chrome");
const flowUse = chrome ? { ...chrome.use, viewport: widths[0].viewport, extraHTTPHeaders: { "CF-Connecting-IP": sourceIp(browsers.length * widths.length) } } : null;
const flowProjects = flowUse
  ? [
      { name: "flows-passkey", testMatch: /flows\/passkey\.setup\.ts/, dependencies: ["attack"], teardown: "flows-cleanup", use: flowUse },
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
    // 全部の通しの後に、開発の置き場が変わっていない事を確かめる
    { name: "records", testMatch: /records\.setup\.ts/, teardown: "dev-state" },
    { name: "dev-state", testMatch: /dev-state\.teardown\.ts/ },
    // 自動の攻撃のチェックはブラウザーを使わず要求だけを送るので、ブラウザーと幅ごとに回さず 1 度だけ流す。
    // 断った要求の通知 (denied_burst) を出し、ほかの画面の帯を途中で変えるので、画面の通しの後に流す
    { name: "attack", testMatch: /attack\.spec\.ts/, dependencies: ["records", ...screenProjects.map((p) => p.name)] },
    ...chosen.map((b) => ({ name: `${LOGIN_PROJECT}${b.name}`, testMatch: /login\.setup\.ts/, dependencies: ["records"], use: b.use })),
    ...screenProjects,
    ...flowProjects,
  ],
  webServer: {
    command: `pnpm run dev --port ${port} --strictPort`,
    // D1 と DO は開発 (pnpm dev) と別の置き場を使い、通しの片付けが開発の状態を変えないようにする
    env: { [PERSIST_ENV]: E2E_STATE },
    url: `http://localhost:${port}/api/v1/health`,
    // 作業ツリーのポートが重なった時に別のツリーのサーバーを使い回さず、起動の失敗で気づく
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
