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
    // 代わりの Cloudflare は、置いていないスクリプトに requests 100、errors 2、Analytics Engine の 5xx 3 を返す。Web アプリは know-office、コンテンツは knowidea-ui のスクリプト名で読む
    seedMain(`UPDATE services SET repo = 'example/know-office' WHERE id = '${OFFICE_ID}'`);
    seedMain(`UPDATE services SET kind = 'content', repo = 'example/knowidea-ui' WHERE id = '${UI_ID}'`);
    const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(fired.ok()).toBe(true);
    await expect(async () => {
      await page.goto(`/services/${OFFICE_ID}`);
      // 失敗率の値は前の通しの行も足されるので、出ている事だけを見る。5xx を足した値は次の通しで見る
      await expect(page.getByRole("group", { name: "直前 24 時間の失敗率" }).locator(".ki-stat__num")).toHaveText(/^\d+\.\d%$/, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.goto(`/services/${UI_ID}`);
    // 記録の行は残るので、前の通しの分が足されて 100 の倍数になる
    await expect(page.getByText("直前 24 時間に読まれた数")).toBeVisible();
    await expect(page.getByText(/^[1-9]\d*00$/)).toBeVisible();
  });

  test("Cron で読んだ訪問の数を、Web アプリの利用者数として画面に出す", async ({ page }) => {
    // 代わりの Cloudflare の Analytics Engine は、置いていないスクリプトに訪問 7 を返す。画面は直前 24 時間の訪問の和を出す
    seedMain(`UPDATE services SET repo = 'example/know-office' WHERE id = '${OFFICE_ID}'`);
    const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(fired.ok()).toBe(true);
    const users = page.getByRole("group", { name: "利用者数" });
    await expect(async () => {
      await page.goto(`/services/${OFFICE_ID}`);
      // 記録の行は残るので、前の通しの分が足されて 7 の倍数になる
      await expect(users.locator(".ki-stat__num")).toHaveText(/^[1-9][\d,]*$/, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(users).toContainText("直前 24 時間の訪問");
  });

  test("Cron で読んだアプリの 5xx を、Web アプリの失敗率に足して画面に出す", async ({ page }) => {
    // 代わりの Cloudflare は、置いていないスクリプトに Worker のエラー 2 と、アプリが返した 5xx 3 を返す。和の 5 が呼び出し 100 の 5.0%
    seedMain(`UPDATE services SET repo = 'example/know-office' WHERE id = '${OFFICE_ID}'`);
    const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
    expect(fired.ok()).toBe(true);
    const rate = page.getByRole("group", { name: "直前 24 時間の失敗率" }).locator(".ki-stat__num");
    // 記録の行は残り、5xx を数える前の通しの行 (2.0%) も足されるので、2.0% より上で 5.0% までになる。Worker のエラーだけなら 2.0% のまま
    await expect(async () => {
      await page.goto(`/services/${OFFICE_ID}`);
      await expect(rate).toHaveText(/^\d+\.\d%$/, { timeout: 1000 });
      const shown = Number.parseFloat((await rate.textContent()) ?? "");
      expect(shown).toBeGreaterThan(2);
      expect(shown).toBeLessThanOrEqual(5);
    }).toPass({ timeout: 20_000 });
  });
});
