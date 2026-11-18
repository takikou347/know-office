import { createHash } from "node:crypto";
import { expect, test as base } from "@playwright/test";
import { FAKES } from "./fakes.ts";

export { expect } from "@playwright/test";

/**
 * テストごとの送信元の IP を返す。手元の入口では全部の要求が設定の送信元として 1 分 300 回のレート制限に数えられ、
 * 通知の帯と拡張の一覧が画面ごとに読むようになると、1 つの幅の通しだけで 300 回を超えて後半の画面が空になったため、テストごとに分ける
 * @param testId Playwright のテストの ID
 * @returns 文書用の範囲 (RFC 3849 の 2001:db8::/32) の IP
 */
export function testSourceIp(testId: string): string {
  const hex = createHash("sha256").update(testId).digest("hex");
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}::1`;
}

/** 画面の通しの test。要求の送信元をテストごとに変え、利用場面の通しが代わりの GitHub に置いた返事を 1 本ごとに外す */
export const test = base.extend<{ forgetGitHubRoutes: void }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({ ...extraHTTPHeaders, "CF-Connecting-IP": testSourceIp(testInfo.testId) });
  },
  // 利用場面の通しは 1 本ずつ流れ、同じ代わりの GitHub を使う。置いた返事が残ると、後の通しが同じ道 (main の ref、同じ番号の PR) で前の返事を受ける
  forgetGitHubRoutes: [
    async ({ playwright }, use, testInfo) => {
      await use();
      if (testInfo.project.name !== "flows") return;
      const request = await playwright.request.newContext();
      try {
        expect((await request.delete(`${FAKES}/github/__fake/routes`)).status()).toBe(204);
      } finally {
        await request.dispose();
      }
    },
    { auto: true },
  ],
});
