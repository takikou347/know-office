// サービスの様子の通し。5 分ごとの Cron が代わりの Cloudflare の GraphQL Analytics API から読み、サービスの様子の画面に失敗率と読まれた数を出す (サービスと拡張の 3.2)。
// 画面から作れない前提 (サービスの種類とリポジトリ) だけを手元の D1 に置き、ゲートウェイの返事は差し替えない
import { expect, test } from "../helpers/test.ts";
import { restoreSeedServices, seedMain } from "./helpers/seed.ts";

const OFFICE_ID = "00000000-0000-7000-8000-000000000102";
const UI_ID = "00000000-0000-7000-8000-000000000101";

test.afterEach(() => {
  // 記録の行は追記だけで消せないので残す。サービスの種類とリポジトリだけを元に戻す
  seedMain(`UPDATE services SET kind = 'library' WHERE id = '${UI_ID}'`);
  restoreSeedServices();
});

test.describe("サービスの種類", () => {
  test("Cron で読んだ Cloudflare の値から、Web アプリの失敗率とコンテンツの読まれた数を画面に出す", async ({ page }) => {
    // 代わりの Cloudflare は、置いていないスクリプトに requests 100、errors 2 を返す。Web アプリは know-office、コンテンツは knowidea-ui のスクリプト名で読む
    seedMain(`UPDATE services SET repo = 'takikou347/know-office' WHERE id = '${OFFICE_ID}'`);
    seedMain(`UPDATE services SET kind = 'content', repo = 'takikou347/knowidea-ui' WHERE id = '${UI_ID}'`);
    const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(fired.ok()).toBe(true);
    await expect(async () => {
      await page.goto(`/services/${OFFICE_ID}`);
      await expect(page.getByText("2.0%")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    // 一意の訪問者は Workers の Analytics に無いので、利用者数は #256 まで出ない
    await expect(page.getByText("利用者数")).toBeVisible();
    await expect(page.getByText("まだ無い").first()).toBeVisible();
    await page.goto(`/services/${UI_ID}`);
    // 記録の行は残るので、前の通しの分が足されて 100 の倍数になる
    await expect(page.getByText("直前 24 時間に読まれた数")).toBeVisible();
    await expect(page.getByText(/^[1-9]\d*00$/)).toBeVisible();
  });
});
