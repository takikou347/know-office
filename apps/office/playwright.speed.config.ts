import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";
import { LOGIN_PROJECT, sessionState } from "./e2e/helpers/session.ts";
import { E2E_STATE, PERSIST_ENV } from "./e2e/helpers/state.ts";

// ダッシュボードの速さ (e2e/speed.spec.ts) を、開発のサーバーでなく build した画面で測る。開発のサーバーはモジュールを 1 本ずつ返すので、本番と同じ運ぶ量にならない。
// build した Worker を vite preview で起こし、本物の入口と同じく文字のファイルを gzip で縮めて返す (dev/plugin.ts の edgeGzip)。
// 待ち受けの番号と代わりの物は playwright.config.ts と同じ物を使うので、画面の通しの後に 1 本ずつ流す (package.json の e2e)
const port = Number(process.env["E2E_PORT"] ?? "5174");
const chromiumPath = process.env["PW_CHROMIUM_PATH"];
const chrome = { ...devices["Desktop Chrome"], ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}) };

export default defineConfig({
  ...base,
  projects: [
    { name: "records", testMatch: /records\.setup\.ts/, teardown: "dev-state" },
    { name: "dev-state", testMatch: /dev-state\.teardown\.ts/ },
    { name: `${LOGIN_PROJECT}chrome`, testMatch: /login\.setup\.ts/, dependencies: ["records"], use: chrome },
    // スマートフォンの幅で 1 本だけ流す。同じ時にほかの画面を開くと回線とCPUを取り合い、測った値が揺れる
    { name: "speed", testMatch: /speed\.spec\.ts/, dependencies: [`${LOGIN_PROJECT}chrome`], fullyParallel: false, workers: 1, use: { ...chrome, viewport: { width: 360, height: 780 }, storageState: sessionState("chrome") } },
  ],
  webServer: {
    // .dev.vars (代わりの物の番号) は build の時に dist に写されるので、playwright.config.ts が書いた後に build する
    command: `pnpm run build && pnpm exec vite preview --port ${String(port)} --strictPort`,
    env: { [PERSIST_ENV]: E2E_STATE },
    url: `http://localhost:${String(port)}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
