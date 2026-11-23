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

/**
 * 設定のカードの編集を押し、その場の入力を開く
 * @param box カード
 * @param label カードの見出し
 */
export async function editCard(box: Locator, label: string): Promise<void> {
  await box.getByRole("button", { name: `${label}を編集`, exact: true }).click();
}

/**
 * 設定のカードの編集の中で、理由を書いて保存を押す
 * @param box カード
 * @param label カードの見出し
 * @param reason 変える理由
 */
export async function saveCard(box: Locator, label: string, reason: string): Promise<void> {
  await box.getByLabel(`${label}を変える理由`).fill(reason);
  await box.getByRole("button", { name: `${label}を保存`, exact: true }).click();
}

/**
 * 設定のカードの編集を取り消す
 * @param box カード
 * @param label カードの見出し
 */
export async function cancelCard(box: Locator, label: string): Promise<void> {
  await box.getByRole("button", { name: `${label}の編集を取り消す`, exact: true }).click();
}

/**
 * カードの中の時刻の欄 (knowidea-ui の TimePicker) を開き、時刻を選ぶ
 * @param box カード
 * @param label 欄の名前
 * @param time 選ぶ時刻 (HH:MM)。欄の刻みに乗る時刻か、今の値
 */
export async function pickTime(box: Locator, label: string, time: string): Promise<void> {
  await box.getByRole("combobox", { name: label }).click();
  await box.page().getByRole("option", { name: time, exact: true }).click();
}
