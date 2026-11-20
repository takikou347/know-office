// サービスの様子の通し。5 分ごとの Cron が代わりの Cloudflare の GraphQL Analytics API から読み、サービスの様子の画面に利用者数、失敗率、読まれた数を出す (サービスと拡張の 3.2)。
// 画面から作れない前提 (サービスの種類とリポジトリ) だけを手元の D1 に置き、ゲートウェイの返事は差し替えない
import { newId } from "@know-office/core";
import { FAKES } from "../helpers/fakes.ts";
import { expect, test } from "../helpers/test.ts";
import { restoreSeedServices, seedMain } from "./helpers/seed.ts";
import { settle } from "./helpers/settle.ts";

const OFFICE_ID = "00000000-0000-7000-8000-000000000102";
const UI_ID = "00000000-0000-7000-8000-000000000101";

test.afterEach(() => {
  // 記録の行は追記だけで消せないので残す。サービスの種類とリポジトリだけを元に戻す
  seedMain(`UPDATE services SET kind = 'library' WHERE id = '${UI_ID}'`);
  restoreSeedServices();
});

test.describe("サービスの種類", () => {
  test("Cron で読んだ Cloudflare の値から、Web アプリの失敗率とコンテンツの読まれた数を画面に出す", async ({ page }) => {
    // 代わりの Cloudflare は、置いていないスクリプトに requests 100、errors 2、Analytics Engine の 5xx 3 を返す。Web アプリは know-office、コンテンツは knowidea-ui のスクリプト名で読む
    seedMain(`UPDATE services SET repo = 'example/know-office' WHERE id = '${OFFICE_ID}'`);
    seedMain(`UPDATE services SET kind = 'content', repo = 'example/knowidea-ui' WHERE id = '${UI_ID}'`);
    const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(fired.ok()).toBe(true);
    await expect(async () => {
      await page.goto(`/services/${OFFICE_ID}`);
      // 失敗率の値は前の通しの行も足されるので、出ている事だけを見る。利用者数と 5xx を足した値は、見本の Web アプリの通しで数をそのまま見る
      await expect(page.getByRole("group", { name: "直前 24 時間の失敗率" }).locator(".ki-stat__num")).toHaveText(/^\d+\.\d%$/, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.goto(`/services/${UI_ID}`);
    // 記録の行は残るので、前の通しの分が足されて 100 の倍数になる
    await expect(page.getByText("直前 24 時間に読まれた数")).toBeVisible();
    await expect(page.getByText(/^[1-9]\d*00$/)).toBeVisible();
  });

  test("見本の Web アプリが共有の型で書いた訪問と 5xx を、サービスの様子の画面に出す", async ({ page }) => {
    // 見本の Web アプリは代わりの物のサーバーの /sample-app/<スクリプト名>/ で動き、共有の型 (@know-office/requests) で代わりの Cloudflare の Analytics Engine に点を書く。
    // 記録の行は追記だけで消せず、前の通しの行が足されるので、通しごとに新しいサービスとスクリプト名を作り、数をそのまま確かめる
    const serviceId = newId({ now: () => Date.now() });
    const script = `know-sample-${serviceId.slice(-12)}`;
    const app = `${FAKES}/sample-app/${script}`;
    await settle(
      async () => {
        // 直に開くと訪問 1。同じサイトの中の移りは訪問に数えない。もう一度直に開くと訪問 2。ページの中の呼び出しが返した 500 は訪問でない 5xx 1
        await page.goto(`${app}/`);
        await page.getByRole("link", { name: "説明" }).click();
        await expect(page.getByRole("heading", { name: "見本の Web アプリの説明" })).toBeVisible();
        await page.goto(`${app}/`);
        await page.getByRole("button", { name: "壊れた API を呼ぶ" }).click();
        await expect(page.getByRole("status")).toHaveText("500");
        // 点を書き終えてからサービスを置く。前の通しの Cron がまだ動いていても、書きかけの数でこの区切りの行を作らない
        seedMain(
          "INSERT INTO services (id, name, kind, stage, idea_id, repo, staff_id, aim, users, cost_estimate, revenue_estimate, study_key, dropped_reason, created_at) " +
            `VALUES ('${serviceId}', '${script}', 'web_app', 'operation', NULL, 'example/${script}', 'builder', '見本の Web アプリ', NULL, NULL, NULL, NULL, NULL, ${String(Date.now())})`,
        );
        const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
        expect(fired.ok()).toBe(true);
        // 代わりの Cloudflare の GraphQL は requests 100、errors 2 を返す。失敗率は Worker のエラー 2 と 5xx 1 の和で 3.0%
        await expect(async () => {
          await page.goto(`/services/${serviceId}`);
          await expect(page.getByRole("group", { name: "利用者数" }).locator(".ki-stat__num")).toHaveText("2", { timeout: 1000 });
        }).toPass({ timeout: 20_000 });
        await expect(page.getByRole("group", { name: "利用者数" })).toContainText("直前 24 時間の訪問");
        await expect(page.getByRole("group", { name: "直前 24 時間の失敗率" }).locator(".ki-stat__num")).toHaveText("3.0%");
      },
      [() => seedMain(`DELETE FROM services WHERE id = '${serviceId}'`)],
    );
  });
});
