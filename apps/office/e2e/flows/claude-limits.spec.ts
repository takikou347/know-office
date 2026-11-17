// Claude の API の上限の通し。代わりの Claude API を使用の上限に切り替え、社員の呼び出しがゲートウェイのプロキシで見分けられて上部の帯に通知が出て、読むまで社員が呼び出しを始めず、読むと続ける事を確かめる。ゲートウェイの返事は差し替えない (サービスと拡張の 3.5)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { FAKES } from "../helpers/fakes.ts";
import { addTask, clockInReviewer, NodeDetail, NodeStatus, openTree, PURPOSE, Runs, scriptFinish, type Tree, Trees } from "./helpers/staff-work.ts";

/** 使用の上限の通知の題 (サービスと拡張の 3.5) */
const SPEND_TITLE = "Claude の API の使用の上限に届いた";

/** 使用の上限で止めるタスクの題の頭。前の通しが落ちて残した物を探す */
const SPEND_TASK = "上限で止まるタスク";

/**
 * 代わりの Claude API で、レビュー担当の呼び出しを使用の上限に切り替えるか戻す
 * @param page 画面を開いたページ
 * @param limit 使用の上限の種類。null で戻す
 */
async function spendLimit(page: Page, limit: "monthly" | null): Promise<void> {
  expect((await page.request.post(`${FAKES}/anthropic/__fake/limit`, { data: { staffId: "reviewer", limit } })).status()).toBe(204);
}

/**
 * 5 分ごとの Cron を開発の入口で 1 度動かす。社員 DO が持っているタスクの呼び出しを始め直す
 * @param page 画面を開いたページ
 */
async function fireCron(page: Page): Promise<void> {
  expect((await page.request.get(`/cdn-cgi/local/scheduled?cron=${encodeURIComponent("*/5 * * * *")}`)).status()).toBe(200);
}

/**
 * 使用の上限を戻し、使用の上限の通知を読み、使用の上限で止めるタスクのうち終わっていない物を見送りにする。残すと次の通しでレビュー担当が先に取る
 * @param page 画面を開いたページ
 */
async function clearSpendLimit(page: Page): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  await spendLimit(page, null);
  const notices = z.object({ data: z.array(z.object({ id: z.string(), title: z.string(), readAt: z.string().nullable() }).loose()) }).parse(await (await page.request.get("/api/v1/notices?limit=100")).json());
  for (const n of notices.data.filter((x) => x.title === SPEND_TITLE && x.readAt === null)) expect((await page.request.put(`/api/v1/notices/${n.id}/read`, { headers })).status()).toBe(204);
  const left = Trees.parse(await (await page.request.get(`/api/v1/nodes?rootId=${PURPOSE}`)).json())
    .data.flatMap(function walk(n: Tree): Tree[] {
      return [n, ...n.children.flatMap(walk)];
    })
    .filter((n) => n.title.startsWith(`${SPEND_TASK} `));
  for (const n of left) {
    const { status, version } = NodeDetail.parse(await (await page.request.get(`/api/v1/nodes/${n.id}`)).json()).data;
    if (status === "done" || status === "dropped") continue;
    expect((await page.request.patch(`/api/v1/nodes/${n.id}`, { headers, data: { version, status: "dropped" } })).status()).toBe(200);
  }
}

test.describe("落ちても続きから", () => {
  test("費用の上限に届く", async ({ page }) => {
    // SDK が上限の返事で終え、Cron を 2 度動かして呼び出しを待つ
    test.slow();
    await openTree(page);
    await clearSpendLimit(page);
    const restore = await clockInReviewer(page);
    try {
      await spendLimit(page, "monthly");
      await page.goto("/goals");
      const title = `${SPEND_TASK} ${String(Date.now())}`;
      const nodeId = await addTask(page, title, "レビュー担当");
      const runsOf = async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()).filter((r) => r.staffId === "reviewer" && r.nodeId === nodeId);
      const statusOf = async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status;
      await expect.poll(runsOf, { timeout: 30_000 }).toHaveLength(1);

      // ゲートウェイのプロキシが上限の返事を見分け、上部の帯に止まる強さの通知が出る。SDK は待ち直さずに終え、タスクは待ちに戻る
      await page.goto("/");
      const bar = page.getByRole("alert").filter({ hasText: SPEND_TITLE });
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await expect.poll(statusOf, { timeout: 60_000 }).toBe("todo");

      // 読むまでは、社員がタスクを取り直し、Cron が動いても、呼び出しを始めない
      expect((await page.request.post("/__dev/staff/reviewer/forget-day")).status()).toBe(204);
      await expect.poll(statusOf).toBe("doing");
      await fireCron(page);
      await page.waitForTimeout(3_000);
      expect(await runsOf()).toHaveLength(1);

      // 上限を直して帯の通知を読むと、次の Cron で社員が続きを始めて終える
      await spendLimit(page, null);
      await bar.getByRole("button", { name: "読んだ" }).click();
      await expect(bar).toBeHidden();
      // 積んだ返事が落ちた通しの後に残らないよう、続きを始める Cron の直前に積む
      await scriptFinish(page);
      await fireCron(page);
      await expect.poll(runsOf, { timeout: 30_000 }).toHaveLength(2);
      await expect.poll(statusOf, { timeout: 60_000 }).toBe("done");
    } finally {
      // 落ちても、上限の切り替え、通知、残ったタスク、広げた勤務の時刻を次の通しに残さない
      try {
        await clearSpendLimit(page);
      } finally {
        await restore();
      }
    }
  });
});
