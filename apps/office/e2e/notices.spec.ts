import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/test.ts";

// 通知が中身の下の帯とダッシュボードに出て、読んだら帯から消える。帯が後から出ても消えても、中身の上の端は動かない (サービスと拡張の 3.5)
// 通知の一覧は境目のモックで返し、画面が送る既読の要求を確かめる。ルートそのものは test/monitoring/notices.test.ts で確かめる
const NOTICE = {
  id: "0190f4a8-0000-7000-8000-000000000301",
  at: "2026-12-08T00:00:00.000Z",
  level: "warn",
  kind: "claude_failing",
  title: "Claude の API の失敗が続いている",
  body: "5 分に 3 回失敗した。最後は 500",
  scope: "office",
  readAt: null,
};
const META = { traceId: "0".repeat(32), next: null };

/**
 * 通知の一覧の返事を、放すまで止めておく
 * @param page 画面
 * @param notice 返す通知
 * @returns 返事を放す関数と、既読の要求の URL
 */
async function holdNotices(page: Page, notice: typeof NOTICE) {
  const gate: { open?: () => void } = {};
  const held = new Promise<void>((done) => {
    gate.open = done;
  });
  const reads: string[] = [];
  await page.route("**/api/v1/notices**", async (route) => {
    await held;
    await route.fulfill({ json: { data: [{ ...notice, readAt: reads.length > 0 ? "2026-12-08T00:05:00.000Z" : null }], meta: META } });
  });
  await page.route("**/api/v1/notices/*/read", async (route) => {
    reads.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  return { release: () => gate.open?.(), reads };
}

/**
 * 物の上の端の位置を返す
 * @param locator 物
 * @returns 上の端
 */
async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("物が見えない");
  return box.y;
}

test("通知が中身の下の帯とダッシュボードに出て、読んだら帯から消える", async ({ page }) => {
  const { release, reads } = await holdNotices(page, NOTICE);
  await page.goto("/");
  const main = page.getByRole("main");
  // 通知の返事を止めたまま、入口の /dashboard の返事から描く今日のタスクが出る
  const heading = main.getByRole("heading", { level: 2, name: "今日のタスク" });
  await expect(heading).toBeVisible();
  await expect(main.getByText("ホームを読んでいます")).toBeHidden();
  const before = { main: await topOf(main), heading: await topOf(heading) };
  release();
  const bar = page.getByRole("status").filter({ hasText: NOTICE.title });
  await expect(bar).toBeVisible();
  await expect(bar.getByText(NOTICE.body)).toBeVisible();
  // 帯は中身の下に出るので、中身の上の端と見出しは動かない
  expect({ main: await topOf(main), heading: await topOf(heading) }).toEqual(before);
  const list = page.getByRole("list", { name: "お知らせ" });
  await expect(list.getByText(NOTICE.title)).toBeVisible();
  await expect(list.getByText("9:00")).toBeVisible();

  await bar.getByRole("button", { name: "読んだ" }).click();
  await expect(bar).toBeHidden();
  expect(reads).toEqual([expect.stringContaining(`/api/v1/notices/${NOTICE.id}/read`)]);
  // 帯が消えても中身は動かず、一覧には読んだ通知も残る
  expect({ main: await topOf(main), heading: await topOf(heading) }).toEqual(before);
  await expect(list.getByText(NOTICE.title)).toBeVisible();
});

test("帯は中身の下、切り替えの上にあり、どちらにも重ならない", async ({ page }) => {
  const { release } = await holdNotices(page, { ...NOTICE, body: "帯の高さを変える長い中身。".repeat(40) });
  await page.goto("/");
  release();
  const band = page.locator(".ko-notice-band");
  await expect(band.getByRole("status")).toBeVisible();
  const main = await page.getByRole("main").boundingBox();
  // 長い帯は中身の下の段の中で送られるので、段の箱で比べる
  const b = await page.locator(".ki-shell__footer").boundingBox();
  if (!main || !b) throw new Error("中身か帯が見えない");
  expect(b.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
  // 長い帯でも中身の段は残る
  expect(main.height).toBeGreaterThan(0);
  const nav = page.getByRole("navigation", { name: "画面の切り替え" });
  const n = await nav.boundingBox();
  if (!n) throw new Error("切り替えが見えない");
  // 左の切り替え (広い幅) なら帯はその右、下の切り替え (狭い幅) なら帯はその上
  if (n.x + n.width <= main.x + 1) expect(b.x).toBeGreaterThanOrEqual(n.x + n.width - 1);
  else expect(b.y + b.height).toBeLessThanOrEqual(n.y + 1);
});

test("帯が出た直後は押しても読んだにならない", async ({ page }) => {
  await page.clock.install();
  const { release, reads } = await holdNotices(page, NOTICE);
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("heading", { name: "今日のタスク" })).toBeVisible();
  release();
  const band = page.locator(".ko-notice-band");
  await expect(band.getByRole("status")).toBeVisible();
  // 中身の下の端を押そうとした指の下に帯が来ても、出た直後は押すのを受けない
  await expect(band).toHaveAttribute("data-fresh", "");
  const read = band.getByRole("button", { name: "読んだ" });
  const box = await read.boundingBox();
  if (!box) throw new Error("読んだが見えない");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(reads).toEqual([]);
  // 押すのを受けない長さ (parts/notices.tsx の NOTICE_FRESH_MS) を過ぎる
  await page.clock.runFor(300);
  await expect(band).not.toHaveAttribute("data-fresh");
  await read.click();
  await expect.poll(() => reads.length).toBe(1);
});

test("Tab で中身の後に帯の「読んだ」へ進み、押して帯が消えても focus は失われない", async ({ page }) => {
  const { release } = await holdNotices(page, NOTICE);
  await page.goto("/");
  release();
  const band = page.locator(".ko-notice-band");
  await expect(band.getByRole("status")).toBeVisible();
  const main = page.getByRole("main");
  await main.focus();
  // 中身の中を Tab で進み、中身を抜けた次が帯の「読んだ」になる
  let left = false;
  for (let i = 0; i < 80 && !left; i++) {
    await page.keyboard.press("Tab");
    left = !(await page.evaluate(() => document.activeElement?.closest("main") !== null));
  }
  await expect(band.getByRole("button", { name: "読んだ" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band.getByRole("status")).toBeHidden();
  await expect(main).toBeFocused();
});
