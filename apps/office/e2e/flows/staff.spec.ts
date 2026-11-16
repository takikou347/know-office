import { expect, test } from "@playwright/test";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { cancelLeftOrders, seedMain } from "./helpers/seed.ts";

// 社員と仕事の画面を、本物のゲートウェイの /staff と指示と会話とタスクで通す。応答を差し替えない (社員と勤怠の 3.4、社員と自動の 3.7)

const TASK = "019a7b00-0000-7000-8000-0000000000e9";

test.describe("オーナーの指示に合わせる", () => {
  test("その日だけ休みにする", async ({ page }) => {
    // 前に流した日の指示が残っていても、同じ指示の 409 にならないよう取り消してから始める
    cancelLeftOrders("reviewer");
    await page.goto("/staff/reviewer");
    await expect(page.getByRole("heading", { level: 2, name: "レビュー担当" })).toBeVisible();
    await page.getByRole("radiogroup", { name: "今日だけの指示" }).getByRole("radio", { name: "休み" }).click();
    await expect(page.getByLabel("終わりの時刻")).toHaveCount(0);
    await page.getByRole("button", { name: "指示を出す" }).click();
    await expect(page.getByText("レビュー担当を今日は休みにしました")).toBeVisible();
    // 前に流した日の取り消した指示も並ぶので、まだ有効な物 (「に出した」) だけを見る
    const orders = page.getByRole("list", { name: "レビュー担当への今日の指示" });
    const active = orders.getByRole("listitem").filter({ hasText: "に出した" });
    await expect(active).toHaveCount(1);
    await expect(active.getByText("休み", { exact: true })).toBeVisible();
    // 同じ日に同じ指示は重ねて出せない
    await page.getByRole("button", { name: "指示を出す" }).click();
    await expect(page.getByText("ほかの所で先に変わりました。")).toBeVisible();
    await active.getByRole("button", { name: "休みの指示を取り消す" }).click();
    await expect(page.getByText("休みの指示を取り消しました")).toBeVisible();
    await expect(active).toHaveCount(0);
  });

  test("延長はパスキーで確かめてから出す", async ({ page }) => {
    cancelLeftOrders("president");
    await page.goto("/staff/president");
    await useOwnerPasskey(page);
    await page.getByRole("radiogroup", { name: "今日だけの指示" }).getByRole("radio", { name: "延長" }).click();
    await page.getByLabel("終わりの時刻").fill("23:59");
    await page.getByRole("button", { name: "指示を出す" }).click();
    await expect(page.getByText("社長に今日の延長を 23:59 までで出しました")).toBeVisible();
    const active = page.getByRole("list", { name: "社長への今日の指示" }).getByRole("listitem").filter({ hasText: "に出した" });
    await expect(active).toHaveCount(1);
    await expect(active.getByText("延長 23:59 まで")).toBeVisible();
    await active.getByRole("button", { name: "延長の指示を取り消す" }).click();
    await expect(active).toHaveCount(0);
  });
});

test.describe("社員との会話", () => {
  test("言葉を送ると会話に残り、社員にまだ渡らない事が分かる", async ({ page }) => {
    const body = `勤怠の表を見た ${String(Date.now())}`;
    await page.goto("/staff/president");
    await expect(page.getByText("社員に渡す仕組みはまだ無く、社員はまだ読みません")).toBeVisible();
    await page.getByLabel("社長への言葉").fill(body);
    await page.getByRole("button", { name: "送る" }).click();
    await expect(page.getByRole("log", { name: "社長との会話" }).getByText(body)).toBeVisible();
    // 読み込み直しても、入口の記録から同じ言葉を読む
    await page.reload();
    await expect(page.getByRole("log", { name: "社長との会話" }).getByText(body)).toBeVisible();
  });
});

test.describe("画面の一覧", () => {
  test("社員の一覧と仕事の山からタスクを開く", async ({ page }) => {
    seedMain(`DELETE FROM nodes WHERE id = '${TASK}'`);
    seedMain(
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${TASK}', 'task', NULL, 'office', '勤怠の CSV を足す', NULL, 'build', 'reviewer', 'waiting_owner', 5, 'president', 1, 1)`,
    );
    await page.goto("/staff");
    const list = page.getByRole("list", { name: "社員" });
    for (const role of ["社長", "開発担当", "レビュー担当"]) await expect(list.getByRole("link", { name: new RegExp(role) })).toBeVisible();
    await list.getByRole("link", { name: /レビュー担当/ }).click();
    await page.getByRole("tab", { name: "仕事の山" }).click();
    await page.getByRole("list", { name: "レビュー担当の仕事" }).getByRole("link", { name: /勤怠の CSV を足す/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "勤怠の CSV を足す" })).toBeVisible();
    await expect(page.getByText("オーナー待ち")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "作業の流れ" })).toBeVisible();
  });
});
