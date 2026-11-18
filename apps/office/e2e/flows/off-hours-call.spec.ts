// 時間外にオーナーが話しかけた時の呼び出しの通し。設定の画面で開き、退勤したレビュー担当に話しかけると、残っていたタスクを取って発言を最初の呼び出しの頭で受ける。ゲートウェイの返事は差し替えない (社員と勤怠の 3.4)
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/test.ts";
import { cancelLeftOrders, seedMain } from "./helpers/seed.ts";
import { ownerPasskey, staffState } from "./helpers/staff.ts";
import { CARRY_TITLE, claudeReceived, dropLeftovers, finishedBy, NodeStatus, openTree, PROJECT, sayToReviewer, scriptFinish } from "./helpers/staff-work.ts";

/**
 * 設定の画面で時間外の呼び出しを開くか閉じる。開く時はパスキーで確かめる
 * @param page 画面を開くページ。開く時は ownerPasskey を付けておく
 * @param enabled 開くか
 */
async function setOffHoursCall(page: Page, enabled: boolean): Promise<void> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "時間外の呼び出し", exact: true }) });
  const check = box.getByRole("checkbox", { name: "勤務の時間の外に話しかけたら社員を呼び出す" });
  await expect(check).toBeVisible();
  if ((await check.isChecked()) === enabled) return;
  await check.click();
  await box.getByLabel("時間外の呼び出しを変える理由").fill("時間外の呼び出しの通し");
  await box.getByRole("button", { name: "時間外の呼び出しを変える" }).click();
  await expect(box.getByText(/時間外の呼び出しを変えました/)).toBeVisible();
}

/**
 * 社員と仕事の画面のボタンでレビュー担当を今日は休みにし、時間外の呼び出しの回数を数え直して、退勤するのを待つ。タスクを持たない勤務中の社員は、休みですぐ退勤する
 * @param page 画面を開くページ
 */
async function restReviewer(page: Page): Promise<void> {
  await page.goto("/staff/reviewer");
  await page.getByRole("radiogroup", { name: "今日だけの指示" }).getByRole("radio", { name: "休み" }).click();
  await page.getByRole("button", { name: "指示を出す" }).click();
  await expect(page.getByText("レビュー担当を今日は休みにしました")).toBeVisible();
  // 同じ日に流し直しても時間外の呼び出しの回数が上限に届かないよう、開発の道で数え直す。休みの日なので出勤はしない
  expect((await page.request.post("/__dev/staff/reviewer/forget-day")).status()).toBe(204);
  await expect.poll(() => staffState(page, "reviewer"), { timeout: 30_000 }).toBe("off");
}

/**
 * レビュー担当の todo のタスクを、社員に知らせずに置く。画面で頼むとその場で呼び出すので、前の勤務から残ったタスクの代わりに直に置く
 * @param title 題。前の通しが落ちて残しても片付くよう、続けるタスクの頭を付ける
 * @returns タスク ID
 */
function seedReviewerTodo(title: string): string {
  const now = Date.now();
  const id = `${now.toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-${(now % 0xffffffffffff).toString(16).padStart(12, "0")}`;
  seedMain(
    `INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('${id}', 'task', '${PROJECT}', 'office', '${title}', '時間外の呼び出しの通し', 'review', 'reviewer', 'todo', 1, 'owner', ${String(now)}, ${String(now)})`,
  );
  return id;
}

test.describe("オーナーの指示に合わせる", () => {
  test("時間外の話しかけで呼び出す", async ({ page }) => {
    test.slow();
    await openTree(page);
    cancelLeftOrders("reviewer");
    await dropLeftovers(page);
    await ownerPasskey(page);
    try {
      await setOffHoursCall(page, true);
      await restReviewer(page);
      const nodeId = seedReviewerTodo(`${CARRY_TITLE} 時間外 ${String(Date.now())}`);
      await scriptFinish(page);
      const said = `時間外の話しかけ ${String(Date.now())}`;
      const bubble = await sayToReviewer(page, said);
      // 退勤した社員が呼び出され、残っていたタスクを取り、発言を最初の呼び出しの頭で受けて終える
      await finishedBy(page, nodeId);
      expect(await claudeReceived(page, said)).toBe(true);
      await page.goto("/staff/reviewer?tab=talk");
      await expect(bubble.getByText("次のタスクの頭で渡しました")).toBeVisible();
      // 頼まれたタスクを終えたら退勤する
      await expect.poll(() => staffState(page, "reviewer"), { timeout: 30_000 }).toBe("off");
    } finally {
      try {
        await setOffHoursCall(page, false);
      } finally {
        cancelLeftOrders("reviewer");
        await dropLeftovers(page);
      }
    }
  });

  test("呼び出しが閉じていれば呼び出さない", async ({ page }) => {
    await openTree(page);
    cancelLeftOrders("reviewer");
    await dropLeftovers(page);
    try {
      await setOffHoursCall(page, false);
      await restReviewer(page);
      const nodeId = seedReviewerTodo(`${CARRY_TITLE} 閉じた時間外 ${String(Date.now())}`);
      const bubble = await sayToReviewer(page, `閉じた時間外の話しかけ ${String(Date.now())}`);
      await expect(bubble.getByText("次のタスクで渡します")).toBeVisible();
      // 発言を返した後も、社員は退勤したままでタスクは待ちのまま
      expect(await staffState(page, "reviewer")).toBe("off");
      expect(NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("todo");
    } finally {
      cancelLeftOrders("reviewer");
      await dropLeftovers(page);
    }
  });
});
