import { expect, test } from "@playwright/test";

// 手で止めるボタン。押すと止まる範囲とタスクの数を確認の画面に出し、確かめた後に止める (自動停止の 3.7)
// ゲートウェイの返事は境目のモックで返し、画面が送る要求の中身を確かめる。ルートそのものは test/guard/routes.test.ts で確かめる
test.describe("通知と手で止めるボタン", () => {
  test("手で止める", async ({ page }) => {
    const previews: unknown[] = [];
    const created: unknown[] = [];
    await page.route("**/api/v1/guard/stop-previews", async (route) => {
      previews.push(route.request().postDataJSON());
      await route.fulfill({ json: { data: { staff: ["president", "builder", "reviewer"], nodes: 3 }, meta: { traceId: "0".repeat(32) } } });
    });
    await page.route("**/api/v1/guard/stops", async (route) => {
      created.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { data: { stopId: "0190f4a8-0000-7000-8000-000000000001" }, meta: { traceId: "0".repeat(32) } } });
    });

    await page.goto("/guard");
    await page.getByRole("button", { name: "すべての社員を止める" }).click();
    const dialog = page.getByRole("dialog", { name: "全体を止めますか" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("止まる範囲: 全体")).toBeVisible();
    await expect(dialog.getByText("止まる社員: 社長、作る役、見る役")).toBeVisible();
    await expect(dialog.getByText("止まるタスク: 3 件")).toBeVisible();
    // 確認の画面を出しただけでは止めない
    expect(created).toEqual([]);
    await dialog.getByRole("button", { name: "止める", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "全体を止めました" })).toBeVisible();
    expect(previews).toEqual([{ scope: "office", target: "office" }]);
    expect(created).toEqual([{ scope: "office", target: "office", reason: "オーナーが画面のボタンで止めた" }]);
  });

  test("取り消すと止めない", async ({ page }) => {
    const created: unknown[] = [];
    await page.route("**/api/v1/guard/stop-previews", (route) =>
      route.fulfill({ json: { data: { staff: ["president", "builder", "reviewer"], nodes: 0 }, meta: { traceId: "0".repeat(32) } } }),
    );
    await page.route("**/api/v1/guard/stops", async (route) => {
      created.push(route.request().postDataJSON());
      await route.fulfill({ status: 500 });
    });
    await page.goto("/guard");
    await page.getByRole("button", { name: "すべての社員を止める" }).click();
    const dialog = page.getByRole("dialog", { name: "全体を止めますか" });
    await dialog.getByRole("button", { name: "取り消す" }).click();
    await expect(dialog).toBeHidden();
    expect(created).toEqual([]);
  });
});
