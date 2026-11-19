// 翌日に続ける通し。レビュー担当がタスクの途中で勤務の終わりを過ぎ、チェックポイントに届いてタスクを持ったまま退勤し、翌日の出勤で同じタスクを先に取って、最後の会話の記録から同じ session の続きを呼ぶ。
// 開発の代わりのワークスペースは本物と同じく会話の記録をゲートウェイに送り、社員 DO が戻した記録を SDK の置き場に書く。ゲートウェイの返事は差し替えない (社員と勤怠の 3.2、社員が考えるの 3.3、3.7)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { FAKES } from "../helpers/fakes.ts";
import { cancelLeftOrders } from "./helpers/seed.ts";
import { part } from "./helpers/screen.ts";
import { settle } from "./helpers/settle.ts";
import { clockIn, scriptReply, staffState } from "./helpers/staff.ts";
import { addTask, CARRY_TITLE, dropLeftovers, NodeStatus, openTree, Runs, scriptFinish } from "./helpers/staff-work.ts";

/** 社員 DO が続きを呼ぶ時の指示 (src/gate/work/transcript.ts の RESUME_PROMPT) の一部 */
const RESUMED = "会話の記録から続きを呼び直した";

/**
 * 日本時間の今から 2 分後の「HH:MM」と、その時刻を返す。終わりの時刻は今より後の分にしか出せない
 * @returns 時刻の文字と協定世界時のミリ秒
 */
function soon(): { hhmm: string; at: number } {
  const jst = new Date(Date.now() + 9 * 60 * 60_000 + 2 * 60_000);
  jst.setUTCSeconds(0, 0);
  const hhmm = `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
  return { hhmm, at: jst.getTime() - 9 * 60 * 60_000 };
}

/**
 * 代わりの Claude API に届いた呼び出しの本文を、1 つずつの文字列で読む
 * @param page 画面を開いたページ
 * @returns 届いた順の本文
 */
async function claudeRequests(page: Page): Promise<string[]> {
  const all = z.array(z.unknown()).parse(await (await page.request.get(`${FAKES}/anthropic/__fake/requests`)).json());
  return all.map((r) => JSON.stringify(r));
}

test.describe("チェックポイントで退勤する", () => {
  test("翌日に続ける", async ({ page }) => {
    // 終わりの時刻を本物の時計で待つ
    test.setTimeout(360_000);
    const until = soon();
    // 22 時より後は通しの勤務の時刻が日をまたぐ形になり、今日の終わりを出せない。0 時の直後は今日の勤務の始まりが終わりの時刻に近い
    test.skip(until.hhmm >= "21:55" || until.hhmm < "00:03", "日をまたぐ勤務の時刻には今日の終わりを出せない");
    await openTree(page);
    cancelLeftOrders("reviewer");
    await dropLeftovers(page);
    const restore = await clockIn(page, "reviewer", true);
    // 途中で落ちても、広げた勤務の時刻、今日の終わりの指示、続けるタスクを次の通しに残さない
    await settle(async () => {
      // 終わりの時刻を過ぎてから、SDK がチェックポイントを伝える。それまで社員はタスクの途中にいる
      const note = `続きは明日 ${String(Date.now())}`;
      const checkpoint = { type: "tool_use", id: "toolu_flow_next_day", name: "mcp__staff__checkpoint", input: { kind: "note", note } };
      await scriptReply(page, "reviewer", [checkpoint], "tool_use", until.at - Date.now() + 15_000);
      // チェックポイントで退勤した後も SDK はその次を求めるので、終わりの文で閉じさせる。社員はもうタスクを離れているので、この終わりはタスクを済にしない
      await scriptReply(page, "reviewer", [{ type: "text", text: "今日はここまで" }], "end_turn");
      await page.goto("/goals");
      const title = `${CARRY_TITLE} ${String(Date.now())}`;
      const nodeId = await addTask(page, title, "レビュー担当");
      const runsOf = async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()).filter((r) => r.staffId === "reviewer" && r.nodeId === nodeId);
      await expect.poll(runsOf, { timeout: 30_000 }).toHaveLength(1);

      // 勤務の時刻はほかの社員と同じなので変えず、社員と仕事の画面のボタンで、レビュー担当の今日の終わりを 2 分後にする
      await page.goto("/staff/reviewer");
      await page.getByRole("radiogroup", { name: "今日だけの指示" }).getByRole("radio", { name: "早退" }).click();
      await page.getByLabel("終わりの時刻").fill(until.hhmm);
      await page.getByRole("button", { name: "指示を出す" }).click();
      await expect(page.getByText(`レビュー担当に今日の早退を ${until.hhmm} までで出しました`)).toBeVisible();

      // 終わりの時刻を過ぎてチェックポイントに届くと、タスクを持ったまま退勤し、タスクは翌日に続ける形で待ちに戻る
      await expect.poll(() => staffState(page, "reviewer"), { timeout: until.at - Date.now() + 90_000 }).toBe("off");
      await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("todo");
      await page.goto(`/staff/reviewer/tasks/${nodeId}`);
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
      await expect(part(page, "作業の流れ").getByText("continued", { exact: true })).toBeVisible();

      // 翌日: 今日の終わりを取り消し、退勤した日の印を消して出勤させる。続けたタスクを先に取り、すぐ SDK が呼ぶので、終わりの返事は出勤させる前に積む
      await page.goto("/staff/reviewer");
      const active = page.getByRole("list", { name: "レビュー担当への今日の指示" }).getByRole("listitem").filter({ hasText: "に出した" });
      await active.getByRole("button", { name: "早退の指示を取り消す" }).click();
      await expect(page.getByText("早退の指示を取り消しました")).toBeVisible();
      await scriptFinish(page);
      expect((await page.request.post("/__dev/staff/reviewer/forget-day")).status()).toBe(204);
      await expect.poll(runsOf, { timeout: 30_000 }).toHaveLength(2);

      // 続きは最初の指示から呼び直さず、戻した会話の記録 (前の日のチェックポイントまで) に続ける指示を足して呼ぶ
      await expect.poll(async () => (await claudeRequests(page)).some((body) => body.includes(RESUMED) && body.includes(note)), { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status, { timeout: 60_000 }).toBe("done");
      expect(await staffState(page, "reviewer")).not.toBe("waiting");

      // タスクの詳細の作業の流れに、前の日に続けた事と、翌日に終えた事が出る
      await page.goto(`/staff/reviewer/tasks/${nodeId}`);
      const flow = part(page, "作業の流れ");
      for (const kind of ["continued", "finished"]) await expect(flow.getByText(kind, { exact: true })).toBeVisible();
    }, [restore, () => cancelLeftOrders("reviewer"), () => dropLeftovers(page)]);
  });
});
