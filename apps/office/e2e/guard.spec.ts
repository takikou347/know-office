import { withGuardLearning } from "./helpers/guard.ts";
import { expect, test } from "./helpers/test.ts";

// 効き目を見る: セキュリティの画面に、止めた回数、誤って止めた割合、多い原因、入れた対策の効き目が出る (自動停止の要件「蒸留」、サービスと拡張の 3.6)
test.describe("蒸留", () => {
  test("効き目を見る", async ({ page }) => {
    const decisions: unknown[] = [];
    await withGuardLearning(page, decisions);
    await page.goto("/guard");
    await expect(page.getByRole("group", { name: "止めた回数" })).toContainText("9");
    await expect(page.getByRole("group", { name: "誤って止めた割合" })).toContainText("40");
    const causes = page.getByRole("region", { name: "多い原因" });
    await expect(causes.getByRole("row").nth(1)).toContainText("社員のルールの外の操作");
    await expect(causes.getByRole("row").nth(1)).toContainText("7 回");
    const measures = page.getByRole("region", { name: "入れた対策の効き目" });
    await expect(measures.getByRole("row").nth(1)).toContainText("push の前にブランチを確かめる");
    await expect(measures.getByRole("row").nth(1)).toContainText("4 回");
    await expect(measures.getByRole("row").nth(1)).toContainText("1 回");

    // 決めていない案は承認でき、入れた案は状態を出す
    const lessons = page.getByRole("region", { name: "蒸留した学び" });
    await expect(lessons.getByRole("row").filter({ hasText: "push の前にブランチを確かめる" })).toContainText("入れた");
    await page.getByRole("button", { name: "main に push しないを承認する" }).click();
    await expect(page.getByRole("status").filter({ hasText: "承認して入れました" })).toBeVisible();
    await expect(page.getByRole("button", { name: "main に push しないを承認する" })).toBeHidden();
    expect(decisions).toEqual([{ decision: "approve", reason: "オーナーが画面で承認した" }]);
  });

  test("効き目を読めない時は、理由と問い合わせの番号を出す", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/v1/guard/effect",
      (route) => route.fulfill({ status: 500, contentType: "application/problem+json", json: { code: "internal", traceId: "f".repeat(32) } }),
    );
    await page.goto("/guard");
    await expect(page.getByRole("alert").filter({ hasText: "効き目を読めませんでした" })).toContainText(`問い合わせの番号: ${"f".repeat(32)}`);
  });
});

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
    await expect(dialog.getByText("止まる社員: 社長、開発担当、レビュー担当")).toBeVisible();
    await expect(dialog.getByText("止まるタスク: 3 件")).toBeVisible();
    // 確認の画面を出しただけでは止めない
    expect(created).toEqual([]);
    await dialog.getByRole("button", { name: "止める", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "全体を止めました" })).toBeVisible();
    expect(previews).toEqual([{ scope: "office", target: "office" }]);
    expect(created).toEqual([{ scope: "office", target: "office", reason: "オーナーが画面のボタンで止めた" }]);
  });
});
