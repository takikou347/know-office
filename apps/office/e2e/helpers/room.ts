// オフィスの部屋の区画と、canvas の今の絵を撮る手伝い
import type { Page } from "@playwright/test";

/**
 * 部屋の区画を返す
 * @param page 見るページ
 * @returns 部屋の区画
 */
export const roomOf = (page: Page) => page.getByRole("region", { name: "オフィスの部屋" });

/**
 * 部屋の canvas の今の絵を返す
 * @param page 見るページ
 * @returns 絵の PNG
 */
export async function pictureOf(page: Page): Promise<Buffer> {
  const canvas = roomOf(page).locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas が無い");
  // canvas の内側だけを撮る。位置が小数の時、要素の絵は外の 1 行 (枠の丸い角) まで入り、動きが止まって重ね方が変わると、その縁のぼかしが 1 段ずれる
  const inset = 2;
  const clip = { x: Math.ceil(box.x) + inset, y: Math.ceil(box.y) + inset, width: Math.floor(box.width) - inset * 2 - 1, height: Math.floor(box.height) - inset * 2 - 1 };
  return page.screenshot({ clip, animations: "allow" });
}

/**
 * 社員を覆うリンクの箱の位置を返す
 * @param page 見るページ
 * @param name リンクの名前
 * @returns 左上の位置
 */
export async function boxOf(page: Page, name: RegExp): Promise<{ x: number; y: number }> {
  const b = await roomOf(page).getByRole("link", { name }).boundingBox();
  return { x: Math.round(b?.x ?? -1), y: Math.round(b?.y ?? -1) };
}
