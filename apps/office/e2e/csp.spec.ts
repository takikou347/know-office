// 本番の画面のファイルに付く CSP (public/_headers) の下で、どの画面も断られる script と style を使わない事を見る (セキュリティの「弱点のチェック」)
import { PRODUCTION_CSP_HEADER } from "../dev/plugin.ts";
import { screens } from "../src/screen/routes.ts";
import { expect, test } from "./helpers/test.ts";

// 開発の入口に、文書の返事へ本番の CSP を付けるよう頼む (dev/plugin.ts の productionCsp)。ゲートウェイの返事は差し替えない
test.use({ extraHTTPHeaders: { [PRODUCTION_CSP_HEADER]: "1" } });

// 開発の入口は CSS を vite の client が <style> で差し込む。本番の build では <link> になるので、vite の client の断りだけは数えない
const DEV_ONLY = /\/@vite\/client/;

test.describe("本番の CSP で断られない", () => {
  // 断りを捕まえて続ける物 (Zod の new Function の試し) は console に出ないので、Chrome の DevTools の知らせ (Audits) で集める
  test.skip(({ browserName }) => browserName !== "chromium", "DevTools の知らせは Chrome だけにある");
  for (const s of screens) {
    test(`${s.label} (${s.path})`, async ({ page }) => {
      const refused: string[] = [];
      const cdp = await page.context().newCDPSession(page);
      cdp.on("Audits.issueAdded", ({ issue }) => {
        const csp = issue.details.contentSecurityPolicyIssueDetails;
        if (csp) refused.push(`${csp.violatedDirective} ${csp.sourceCodeLocation?.url ?? csp.blockedURL ?? ""}`);
      });
      await cdp.send("Audits.enable");
      const res = await page.goto(s.path);
      expect(res?.headers()["content-security-policy"]).toContain("style-src 'self';");
      await expect(page.getByRole("heading", { level: 1, name: s.label })).toBeVisible();
      expect(refused.filter((line) => !DEV_ONLY.test(line))).toEqual([]);
    });
  }
});
