// 週のバッチ処理の終わりを見る時に Claude の鍵が断られたら、5 分ごとの Cron から通知を出し、ダッシュボードの帯で読むまで送らない (サービスと拡張の 3.6)
import { expect, test } from "../helpers/test.ts";
import { claudeKeys, setClaudeKeys } from "../helpers/fakes.ts";
import { seedMain } from "./helpers/seed.ts";
import { AUTH_TITLE, noticeBar } from "./helpers/notice-bar.ts";

test.describe("落ちても続きから", () => {
  test("鍵が断られる", async ({ page }) => {
    // 帯の前にほかの通知を読んで送るので、30 秒を超える事がある
    test.slow();
    const keys = await claudeKeys(page.request);
    // 前の通しが残した読んでいない鍵の通知があると、送らずに帯だけが出るので、先に読んだ事にする
    seedMain(`UPDATE notices SET read_at = ${String(Date.now())} WHERE kind = 'sdk_auth_failed' AND read_at IS NULL`);
    const tag = crypto.randomUUID().replaceAll("-", "");
    const id = crypto.randomUUID();
    // 送った後のバッチは画面から作れないので、送った行を置く。急ぐ故障の鍵は日と指紋で、通しごとに変える
    seedMain(`INSERT INTO batches (id, kind, week, batch_id, status, detail, created_at, ended_at, failures) VALUES ('${id}', 'urgent', 'e2e-${tag}', 'msgbatch_e2e${tag}', 'submitted', NULL, ${String(Date.now())}, NULL, 0)`);
    try {
      // Anthropic の画面でゲートウェイの鍵を消した時にあたる
      await setClaudeKeys(page.request, []);
      const fired = await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`);
      expect(fired.ok()).toBe(true);
      await page.goto("/");
      const bar = await noticeBar(page, "status", AUTH_TITLE, 60_000);
      await expect(bar.getByText("設定で鍵を確かめ")).toBeVisible();
      // 鍵を入れ直してから通知を読む。読むまでは送らず、終わりも見ない
      await setClaudeKeys(page.request, keys);
      await bar.getByRole("button", { name: "読んだ" }).click();
      await expect(bar).toBeHidden();
    } finally {
      await setClaudeKeys(page.request, keys);
      seedMain(`DELETE FROM batches WHERE id = '${id}'`);
      // 落ちて読まずに終わっても、後の通しの社員を止めない
      seedMain(`UPDATE notices SET read_at = ${String(Date.now())} WHERE kind = 'sdk_auth_failed' AND read_at IS NULL`);
    }
  });
});
