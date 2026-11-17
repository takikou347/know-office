import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/test.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { seedMain } from "./helpers/seed.ts";

// オーナーの情報を扱う拡張 (職務経歴) を、本物のゲートウェイの拡張の入れ切り、/ext/career/profile、/ext/career/showcase で通す。応答を差し替えない (サービスと拡張の 3.8)

const PROFILE = { summary: "Web の画面を作ってきた", history: "2019 年から社内の勤怠の仕組みを作った", skills: "TypeScript と React" };

/**
 * 設定の画面で職務経歴の拡張を入れるか外す。今の状態がそのままなら何もしない
 * @param page 開いているページ
 * @param enabled 入れるか
 */
async function setCareer(page: Page, enabled: boolean): Promise<void> {
  await page.goto("/settings");
  const want = page.getByRole("button", { name: `職務経歴を${enabled ? "外す" : "入れる"}` });
  const toggle = page.getByRole("button", { name: `職務経歴を${enabled ? "入れる" : "外す"}` });
  await expect(want.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await expect(want).toBeVisible();
}

test.describe("職務経歴の拡張", () => {
  test("入れて、パスキーで確かめてから開き、置いた経歴のうち見せる項目だけを書き出す", async ({ page }) => {
    await useOwnerPasskey(page);
    // owner_data は今の状態の表なので、前の通しが残した経歴を消してから始め、終わる時にも消す
    seedMain("DELETE FROM owner_data WHERE ext_id = 'career';");
    try {
      // 入れるとできる操作が増えるので、パスキーで確かめてから入れる
      await setCareer(page, true);
      await page.goto("/ext/career");
      await expect(page.getByRole("heading", { level: 1, name: "職務経歴" })).toBeVisible();
      const profile = page.getByRole("form", { name: "職務経歴" });
      await profile.getByRole("textbox", { name: "自己紹介" }).fill(PROFILE.summary);
      await profile.getByRole("textbox", { name: "経歴" }).fill(PROFILE.history);
      await profile.getByRole("textbox", { name: "できる事" }).fill(PROFILE.skills);
      await profile.getByRole("button", { name: "置く" }).click();
      await expect(profile.getByText("置きました")).toBeVisible();

      // 開き直すと、パスキーで確かめた後に、暗号を解いた中身が出る
      await page.reload();
      await expect(page.getByRole("form", { name: "職務経歴" }).getByRole("textbox", { name: "経歴" })).toHaveValue(PROFILE.history);

      // 見せる項目だけを書き出す。選ばない項目は書き出した物に出ない
      const showcase = page.getByRole("form", { name: "人に見せる項目" });
      await showcase.getByRole("checkbox", { name: "自己紹介" }).check();
      await showcase.getByRole("checkbox", { name: "経歴" }).uncheck();
      await showcase.getByRole("checkbox", { name: "できる事" }).check();
      await showcase.getByRole("button", { name: "書き出す" }).click();
      const written = showcase.getByRole("region", { name: "書き出した物" });
      await expect(written.getByText(PROFILE.skills)).toBeVisible();
      await expect(written.getByText(PROFILE.summary)).toBeVisible();
      await expect(written.getByText(PROFILE.history)).toHaveCount(0);
    } finally {
      await setCareer(page, false);
      seedMain("DELETE FROM owner_data WHERE ext_id = 'career';");
    }
  });
});
