import { createHash } from "node:crypto";
import { test as base } from "@playwright/test";

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

/** 画面の通しの test。要求の送信元をテストごとに変える */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({ ...extraHTTPHeaders, "CF-Connecting-IP": testSourceIp(testInfo.testId) });
  },
});
