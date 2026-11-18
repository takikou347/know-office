import type { Request } from "@playwright/test";
import { expect, test } from "./helpers/test.ts";
import { distinct, REVIEW_ID, stubReview, REVIEW_PATH } from "./helpers/review.ts";

// エディタとワークスペース。読むだけの間はエディタのコードも補完の口 (lsp) も読まない。入口の返事は境目のモックで返す (タスクとレビューの 3.2)

const editorCode = /codemirror|knowidea-ui_editor|editor-/i;

test.describe("ワークスペースを起こす時", () => {
  test("読むだけ", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r: Request) => urls.push(new URL(r.url()).pathname));
    const called = await stubReview(page);
    await page.goto(REVIEW_PATH);
    await expect(page.locator(".ki-diff").first()).toBeVisible();
    await page.getByRole("button", { name: /src\/format\.ts/ }).click();
    await expect(page.getByText("export const v2 = 2;")).toBeVisible();
    // 補完の口を開かないので、ワークスペースは起きない。読むのは概要と差分と読んだ所の印だけ
    expect(urls.filter((u) => u.endsWith("/lsp"))).toEqual([]);
    const base = `/api/v1/reviews/${REVIEW_ID}`;
    expect(distinct(called).toSorted()).toEqual([`GET ${base}`, `GET ${base}/diff?path=src%2Fattendance.ts`, `GET ${base}/diff?path=src%2Fformat.ts`, `PUT ${base}/seen`].toSorted());
    expect(urls.filter((u) => editorCode.test(u))).toEqual([]);
  });
});
