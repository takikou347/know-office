// 入口が画面の HTML に付ける CSP (要求ごとの nonce) の下で、どの画面もエディタも、断られる script と style を使わない事を見る (セキュリティの「弱点のチェック」)
import type { Page } from "@playwright/test";
import { screens } from "../src/screen/routes.ts";
import { REVIEW_PATH, stubReview } from "./helpers/review.ts";
import { expect, test } from "./helpers/test.ts";

/**
 * 断られた物を集め始める。断りを捕まえて続ける物 (Zod の new Function の試し) は console に出ないので、Chrome の DevTools の知らせ (Audits) で集める
 * @param page 開くページ
 * @returns 断られた物の並び (向き、元のファイル)
 */
async function watchRefused(page: Page): Promise<string[]> {
  const refused: string[] = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Audits.issueAdded", ({ issue }) => {
    const csp = issue.details.contentSecurityPolicyIssueDetails;
    if (csp) refused.push(`${csp.violatedDirective} ${csp.sourceCodeLocation?.url ?? csp.blockedURL ?? ""}`);
  });
  await cdp.send("Audits.enable");
  return refused;
}

test.describe("本番の CSP で断られない", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "DevTools の知らせは Chrome だけにある");

  for (const s of screens) {
    test(`${s.label} (${s.path})`, async ({ page }) => {
      const refused = await watchRefused(page);
      const res = await page.goto(s.path);
      // 開発の入口でも、入口 (src/gate/screen-html.ts) が本番と同じく nonce の付いた CSP を付ける
      expect(res?.headers()["content-security-policy"]).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/]{22}==';/);
      await expect(page.getByRole("heading", { level: 1, name: s.label })).toBeVisible();
      expect(refused).toEqual([]);
    });
  }

  test("レビューのエディタ (CodeMirror)", async ({ page }) => {
    const refused = await watchRefused(page);
    await stubReview(page);
    await page.goto(REVIEW_PATH);
    await page.getByRole("combobox", { name: "直すファイル" }).click();
    await page.getByRole("option", { name: "src/attendance.ts" }).click();
    await expect(page.locator(".cm-editor").first()).toBeVisible();
    // CodeMirror の土台の見た目 (差し込んだ <style>) が付いている
    await expect(page.locator(".cm-editor").first()).toHaveCSS("display", "flex");
    expect(refused).toEqual([]);
  });
});
