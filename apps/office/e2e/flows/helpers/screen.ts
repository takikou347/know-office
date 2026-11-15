// 利用場面の通しで、画面の部分を見出しから探す
import type { Locator, Page } from "@playwright/test";

/**
 * 見出し (h2) の付いた部分を探す
 * @param page 開いているページ
 * @param title 見出しの文
 * @returns その部分
 */
export function part(page: Page, title: string): Locator {
  return page.getByRole("main").locator("section", { has: page.getByRole("heading", { level: 2, name: title, exact: true }) });
}

/**
 * 画面が作ったログインセッションで、ゲートウェイに書く要求を送る。前のテストが残した物を片付けるのに使う
 * @param page 開いているページ。画面を 1 度開いてログインセッションを持っている事
 * @param path API の道
 * @returns ステータス
 */
export async function post(page: Page, path: string): Promise<number> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(path, { headers: { Origin: origin } });
  return res.status();
}
