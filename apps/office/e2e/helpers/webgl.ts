// 画面の通しで、WebGL を出せないブラウザに見せる
import type { Page } from "@playwright/test";

/**
 * そのページでは WebGL の canvas を作れないようにする。2D の一覧に代わる事を確かめる
 * @param page 開くページ
 */
export async function withoutWebgl(page: Page): Promise<void> {
  await page.addInitScript({
    content: `{
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
        return String(kind).startsWith("webgl") ? null : original.call(this, kind, ...rest);
      };
    }`,
  });
}
