import { expect, test } from "./helpers/test.ts";

// 入れた管理の拡張の画面が 8 の画面の後ろに並ぶ (サービスと拡張の 3.8)
// ゲートウェイの返事は境目のモックで返し、画面が送る要求の中身を確かめる。ルートそのものは test/extensions/plug.test.ts で確かめる
const META = { traceId: "0".repeat(32) };

test.describe("8 の画面", () => {
  test("入れた拡張の画面", async ({ page }) => {
    let enabled = false;
    const toggles: unknown[] = [];
    const row = () => ({ id: "sample-notes", title: "メモ", enabled, ownerData: false });
    // 一覧は問い (?limit=100) を付けて読むので、パスで合わせる
    await page.route((url) => url.pathname === "/api/v1/extensions", (route) => route.fulfill({ json: { data: [row()], meta: { ...META, next: null } } }));
    await page.route("**/api/v1/extensions/sample-notes", async (route) => {
      toggles.push(route.request().postDataJSON());
      enabled = true;
      await route.fulfill({ json: { data: row(), meta: META } });
    });
    await page.route("**/api/v1/ext/sample-notes/note", (route) => route.fulfill({ json: { data: { body: "金曜は早く上がる" }, meta: META } }));

    await page.goto("/settings");
    await expect(page.getByRole("main").getByText("入れていない")).toBeVisible();
    await page.getByRole("button", { name: "メモを入れる" }).click();
    await expect(page.getByRole("main").getByText("入れている")).toBeVisible();
    expect(toggles).toEqual([{ enabled: true }]);

    // 左の切り替えか、狭い幅ではその他から、8 の画面の後ろの拡張の画面へ移る
    const side = page.getByRole("navigation").getByRole("link", { name: "メモ" });
    if (await side.isVisible()) {
      await side.click();
    } else {
      await page.getByRole("navigation").getByRole("link", { name: "その他" }).click();
      await page.getByRole("main").getByRole("link", { name: "メモ" }).click();
    }
    await expect(page.getByRole("heading", { level: 1, name: "メモ" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "メモ" })).toHaveValue("金曜は早く上がる");
  });
});
