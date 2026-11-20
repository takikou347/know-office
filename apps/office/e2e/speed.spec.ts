import type { Request } from "@playwright/test";
import { expect, test } from "./helpers/test.ts";

// ダッシュボードの速さ。build した画面 (playwright.speed.config.ts のプレビュー) を、スマートフォンの幅と 4G を模した回線で、
// 何も溜めていないブラウザーから開き、社員の様子が出るまでを 2 秒以内にする (画面の全体の 3.4)。応答を差し替えない

/** 4G を模した回線 (画面の全体の 3.4)。要求ごとに往復 150 ミリ秒を足し、下り 1.6 Mbps、上り 750 kbps に絞る。値はバイト毎秒 */
const SLOW_4G = { latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 } as const;

/** ダッシュボードの主な中身が出るまでの上限 (ミリ秒) */
const LIMIT_MS = 2000;

/** 画面が開いて最初の API の呼び出しに付ける訪問の印 (core の VISIT_HEADER) */
const VISIT_HEADER = "x-visit";

test.describe("速さ", () => {
  test("ダッシュボードの速さ", async ({ page, browser, storageState }) => {
    // 入口の Worker の最初の組み立てを測らないよう、溜めを分けた別のブラウザーで 1 度開いておく
    const warm = await browser.newContext({ storageState: typeof storageState === "string" ? storageState : undefined });
    try {
      const first = await warm.newPage();
      await first.goto("/");
      await expect(first.getByRole("heading", { level: 2, name: "社員の様子" })).toBeVisible();
    } finally {
      await warm.close();
    }

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...SLOW_4G });
    await page.goto("/", { waitUntil: "commit" });
    // 社員の様子の見出しが見えた時を、画面の開き始め (performance の 0) からのミリ秒で、画面の中で取る
    const shown = await page.waitForFunction(
      () => {
        const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "社員の様子");
        return heading?.checkVisibility() ? performance.now() : false;
      },
      undefined,
      { polling: "raf", timeout: 15_000 },
    );
    const ms = Math.round(Number(await shown.jsonValue()));
    // どこで時間を使ったかを残す。画面の JS を読み終えた時と、ダッシュボードの API を読み終えた時 (どちらも画面の開き始めからのミリ秒)
    const loaded = await page.evaluate(() => {
      const entries = performance.getEntriesByType("resource").filter((e): e is PerformanceResourceTiming => e instanceof PerformanceResourceTiming);
      const end = (match: (name: string) => boolean) => Math.round(Math.max(0, ...entries.filter((e) => match(new URL(e.name).pathname)).map((e) => e.responseEnd)));
      return { js: end((path) => path.endsWith(".js")), dashboard: end((path) => path === "/api/v1/dashboard") };
    });
    test.info().annotations.push(
      { type: "社員の様子までのミリ秒", description: String(ms) },
      { type: "画面の JS を読み終えたミリ秒", description: String(loaded.js) },
      { type: "ダッシュボードの API を読み終えたミリ秒", description: String(loaded.dashboard) },
    );
    expect(ms, `社員の様子まで ${String(ms)} ミリ秒`).toBeLessThanOrEqual(LIMIT_MS);
  });

  test("ダッシュボードの API を 1 度だけ読み、訪問の印を 1 度だけ付ける", async ({ page }) => {
    // HTML の先読みと画面の fetch が噛み合わないと、ダッシュボードを 2 度読むか、訪問の印 (x-visit) が届かずに訪問を数えない。
    // 配信がつながると画面はダッシュボードを読み直す (useLiveTick) ので、配信の WebSocket を開く前の要求だけを数える
    const calls: { path: string; visit: boolean; beforeLive: boolean; request: Request }[] = [];
    let live = false;
    page.on("websocket", () => {
      live = true;
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      calls.push({ path: url.pathname, visit: request.headers()[VISIT_HEADER] === "1", beforeLive: !live, request });
    });
    const opened = page.waitForEvent("websocket", (ws) => ws.url().includes("/api/v1/live"));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: "社員の様子" })).toBeVisible();
    await opened;
    expect(calls.filter((c) => c.path === "/api/v1/dashboard" && c.beforeLive)).toHaveLength(1);
    const visits = calls.filter((c) => c.visit);
    expect(visits.map((c) => c.path)).toHaveLength(1);
    // 印はログインを通った呼び出しで数える (src/gate/services/requests.ts)
    expect((await visits[0]?.request.response())?.status()).toBe(200);
  });
});
