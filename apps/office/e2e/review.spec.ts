import { expect, test } from "./helpers/test.ts";
import { distinct, REVIEW_ID, REVIEW_PATH, stubReview } from "./helpers/review.ts";

// 入口にあるレビューを開く。要点とチェックを変更の前に出し、幅 1,024 以上は前と後を左右に、狭い時は 1 列に並べる。入口の返事は境目のモックで返す (タスクとレビューの 3.6)

const width = (page: { viewportSize: () => { width: number } | null }) => page.viewportSize()?.width ?? 0;

test.describe("変更の見せ方", () => {
  test("パソコンで開く", async ({ page }) => {
    test.skip(width(page) < 1024, "幅 1,024 以上だけ");
    await stubReview(page);
    await page.goto(REVIEW_PATH);
    const diff = page.locator(".ki-diff").first();
    await expect(diff).toHaveAttribute("data-layout", "split");
    await expect(diff.locator('[data-side="left"][data-type="del"]')).toContainText("const empty = null;");
    await expect(diff.locator('[data-side="right"][data-type="add"]')).toContainText("const empty = 0;");
  });

  test("スマートフォンで開く", async ({ page }) => {
    test.skip(width(page) >= 600, "1 列になる幅だけ");
    await stubReview(page);
    await page.goto(REVIEW_PATH);
    const diff = page.locator(".ki-diff").first();
    await expect(diff).toHaveAttribute("data-layout", "unified");
    await expect(diff.locator('[data-side="left"]')).toHaveCount(0);
    await expect(diff.getByText("const empty = 0;")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("社員の所見と判断", () => {
  test("要点から読む", async ({ page }) => {
    await stubReview(page);
    await page.goto(REVIEW_PATH);
    const summary = page.getByText("空の日の勤怠を 0 で出すように直した。気になる所は無い");
    const checks = page.getByRole("list", { name: "チェックの結果" });
    const changes = page.getByRole("heading", { level: 2, name: "変更", exact: true });
    await expect(summary).toBeVisible();
    await expect(checks.getByText("verify")).toBeVisible();
    await expect(checks.getByText("通った")).toBeVisible();
    // 要点とチェックは、変更より上に出る
    const top = async (l: typeof summary) => (await l.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
    expect(await top(summary)).toBeLessThan(await top(changes));
    expect(await top(checks)).toBeLessThan(await top(changes));
  });
});

test("1,000 行の変更も、最初のファイルだけを先に読んで出す", async ({ page }) => {
  test.skip(width(page) < 600, "読む順は幅で変わらないので、幅 1,280 だけで見る");
  // 2 秒の速さ (要件 screens のレビューを開く速さ) は、開発のサーバーでは測れないので、本番の形で測る時に確かめる
  const called = await stubReview(page, { firstLines: 1000 });
  await page.goto(REVIEW_PATH);
  await expect(page.locator(".ki-diff").first().getByText("export const v999 = 999;")).toBeVisible();
  expect(distinct(called).filter((c) => c.includes("/diff"))).toEqual([`GET /api/v1/reviews/${REVIEW_ID}/diff?path=src%2Fattendance.ts`]);
});

test("残りのファイルは開いた時に読み、開いた先を読んだ事にする", async ({ page }) => {
  test.skip(width(page) < 600, "読む順は幅で変わらないので、幅 1,280 だけで見る");
  const called = await stubReview(page);
  await page.goto(REVIEW_PATH);
  await expect(page.locator(".ki-diff").first()).toBeVisible();
  await expect.poll(() => called.find((c) => c.method === "PUT")).toEqual({ method: "PUT", path: expect.stringMatching(/\/seen$/) });
  await page.getByRole("button", { name: /src\/format\.ts/ }).click();
  await expect(page.getByText("export const v2 = 2;")).toBeVisible();
  expect(distinct(called).filter((c) => c.includes("/diff"))).toEqual([`GET /api/v1/reviews/${REVIEW_ID}/diff?path=src%2Fattendance.ts`, `GET /api/v1/reviews/${REVIEW_ID}/diff?path=src%2Fformat.ts`]);
});
