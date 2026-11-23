// 時間外の呼び出しの通し。退勤したレビュー担当に、オーナーが目標の画面でタスクを頼むと、その社員だけが呼び出されて進める。設定の画面で時間外の呼び出しを開いて話しかけると、発言がその社員のタスクになり、呼び出された社員が取って本文で受ける。ゲートウェイの返事は差し替えない (社員と勤怠の 3.4)
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/test.ts";
import { cancelLeftOrders, seedMain } from "./helpers/seed.ts";
import { idleStaff, ownerPasskey, scriptReply, staffState, unstick } from "./helpers/staff.ts";
import { addTask, CARRY_TITLE, claudeReceived, dropLeftovers, dropTodos, finishedBy, NodeStatus, openTree, PROJECT, sayToReviewer, scriptFinish } from "./helpers/staff-work.ts";
import { cancelCard, editCard, saveCard } from "./helpers/screen.ts";

/**
 * 設定の画面で時間外の呼び出しを開くか閉じる。開く時はパスキーで確かめる
 * @param page 画面を開くページ。開く時は ownerPasskey を付けておく
 * @param enabled 開くか
 */
async function setOffHoursCall(page: Page, enabled: boolean): Promise<void> {
  await page.goto("/settings");
  const box = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: "時間外の呼び出し", exact: true }) });
  const check = box.getByRole("checkbox", { name: "勤務の時間の外に話しかけたら社員を呼び出す" });
  await editCard(box, "時間外の呼び出し");
  await expect(check).toBeVisible();
  if ((await check.isChecked()) === enabled) {
    await cancelCard(box, "時間外の呼び出し");
    return;
  }
  await check.click();
  await saveCard(box, "時間外の呼び出し", "時間外の呼び出しの通し");
  await expect(box.getByText(/時間外の呼び出しを変えました/)).toBeVisible();
}

/**
 * 社員と仕事の画面のボタンでレビュー担当を今日は休みにし、時間外の呼び出しの回数を数え直して、退勤するのを待つ。タスクを持たない勤務中の社員は、休みですぐ退勤する
 * @param page 画面を開くページ
 */
async function restReviewer(page: Page): Promise<void> {
  await page.goto("/staff/reviewer");
  await page.getByRole("radiogroup", { name: "今日だけの指示" }).getByRole("radio", { name: "休み" }).click();
  await page.getByRole("button", { name: "変更を登録する" }).click();
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
  test("時間外の呼び出し", async ({ page }) => {
    test.slow();
    await openTree(page);
    cancelLeftOrders("reviewer");
    await dropLeftovers(page);
    try {
      // 時間外の話しかけの呼び出しは閉じたままでも、オーナーが頼んだタスクでは呼び出す
      await setOffHoursCall(page, false);
      // 前の通しが落ちて残した待ちと持っているタスクがあれば、片付けてから休みにする
      await unstick(page, "reviewer");
      await idleStaff(page, "reviewer");
      await restReviewer(page);
      const others = await Promise.all(["president", "builder"].map((id) => staffState(page, id)));
      // 呼び出された間を画面で見られるよう、終わりの返事を少し遅らせる
      await scriptReply(page, "reviewer", [{ type: "text", text: "時間外のタスクを終えた" }], "end_turn", 15_000);
      await page.goto("/goals");
      const title = `${CARRY_TITLE} 時間外に頼む ${String(Date.now())}`;
      const nodeId = await addTask(page, title, "レビュー担当");
      // 退勤していたレビュー担当だけが呼び出しで出勤し、頼まれたタスクを進める
      await expect.poll(() => staffState(page, "reviewer"), { timeout: 30_000 }).toBe("called");
      await page.goto("/staff/reviewer");
      await expect(page.getByRole("main").getByText("呼ばれて働いている").first()).toBeVisible();
      // ほかの社員は呼び出さない
      const after = await Promise.all(["president", "builder"].map((id) => staffState(page, id)));
      for (const [i, state] of after.entries()) if (others[i] !== "called") expect(state).not.toBe("called");
      await finishedBy(page, nodeId);
      // 頼まれたタスクを終えたら退勤する
      await expect.poll(() => staffState(page, "reviewer"), { timeout: 30_000 }).toBe("off");
    } finally {
      cancelLeftOrders("reviewer");
      await dropLeftovers(page);
    }
  });

  test("時間外の話しかけで呼び出す", async ({ page }) => {
    test.slow();
    await openTree(page);
    cancelLeftOrders("reviewer");
    await dropLeftovers(page);
    await ownerPasskey(page);
    try {
      await setOffHoursCall(page, true);
      await restReviewer(page);
      await scriptFinish(page);
      const said = `時間外の話しかけ ${String(Date.now())}`;
      const bubble = await sayToReviewer(page, said);
      // 発言はレビュー担当のタスクになり、退勤した社員が呼び出されて取り、本文で受けて終える
      await expect(bubble.getByText("タスクにしました")).toBeVisible();
      const taskId = ((await bubble.getByRole("link", { name: "タスクを開く" }).getAttribute("href")) ?? "").split("/").at(-1) ?? "";
      await finishedBy(page, taskId);
      expect(await claudeReceived(page, said)).toBe(true);
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
      await expect(bubble.getByText("タスクにしました")).toBeVisible();
      // 発言を返した後も、社員は退勤したままでタスクは待ちのまま
      expect(await staffState(page, "reviewer")).toBe("off");
      expect(NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("todo");
    } finally {
      cancelLeftOrders("reviewer");
      await dropLeftovers(page);
      // 発言から足したタスクは目的の木の外の受け付けにあるので、待ちの物を見送りにする
      await dropTodos(page, "reviewer");
    }
  });
});
