// 山が空になった時の通し。開発担当の山が空になると、上司の社長に「開発担当の次のタスクを作る」が足され、社長が社員のツールでタスクを作って開発担当に割り振り、開発担当が取って終える。
// ゲートウェイの返事は差し替えず、社員の SDK は手元の代わりの Claude API だけを呼ぶ (タスクとレビューの 3.1 の 2)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { giveBackTasks, releaseTask, setAsideTasks } from "./helpers/dev-loop.ts";
import { readMain, seedMain } from "./helpers/seed.ts";
import { part } from "./helpers/screen.ts";
import { settle } from "./helpers/settle.ts";
import { clockIn, forgetReplies, scriptReply, staffNow } from "./helpers/staff.ts";
import { NodeStatus, openTree, PROJECT, PURPOSE, Runs, Trees, type Tree } from "./helpers/staff-work.ts";
import { FAKES } from "../helpers/fakes.ts";

const PLAN_TITLE = "開発担当の次のタスクを作る";
const Open = z.object({ data: z.array(z.object({ id: z.string(), title: z.string() }).loose()) });

/**
 * 社長の開いている「開発担当の次のタスクを作る」を見送りにし、社長が持っていれば離れるのを待つ。開発担当が終えた後にまた山が空になって足された物を、後の通しに残さない
 * @param page 画面を開いたページ
 */
async function dropOpenPlans(page: Page): Promise<void> {
  const dropped = new Set<string>();
  for (const status of ["doing", "todo"]) {
    const open = Open.parse(await (await page.request.get(`/api/v1/nodes?assignee=president&status=${status}&limit=100`)).json()).data.filter((n) => n.title === PLAN_TITLE);
    for (const n of open) {
      dropped.add(n.id);
      await expect(() => releaseTask(page, n.id, "president")).toPass({ timeout: 10_000 });
    }
  }
  await expect.poll(async () => dropped.has((await staffNow(page, "president")).nodeId ?? ""), { timeout: 30_000 }).toBe(false);
}

test.describe("タスクの繰り返し", () => {
  test("山が空になる", async ({ page }) => {
    // 2 人の山を外し、社員 2 人の SDK の呼び出しを待ち、落ちた時も後始末を走らせ切る
    test.setTimeout(240_000);
    const started = Date.now();
    // 前の通しが残した読んでいない鍵と上限の通知は、どの社員の呼び出しも止めるので、先に読んだ事にする
    seedMain(`UPDATE notices SET read_at = ${String(started)} WHERE kind IN ('sdk_auth_failed', 'claude_spend_limit') AND read_at IS NULL`);
    await openTree(page);
    // 開発担当の山を空にし、社長の山も空にして、社長が足された「開発担当の次のタスクを作る」をすぐ取るようにする
    // 後始末は足した順の逆に走らせる。勤務の時刻を戻してから見送りと戻しをするので、広げた勤務の間に戻したタスクを取らない
    const undo: (() => unknown)[] = [];
    await settle(async () => {
      const builder = await setAsideTasks(page, "builder");
      undo.unshift(() => giveBackTasks(builder, "builder"));
      // 終わった後にまた空になった開発担当が足させた物と、外した物から戻した物を、勤務の時刻を戻した後に見送る
      undo.unshift(() => dropOpenPlans(page));
      const president = await setAsideTasks(page, "president");
      undo.unshift(() => giveBackTasks(president, "president"));
      await forgetReplies(page, "president");
      await forgetReplies(page, "builder");

      // 社長は社員のツールでタスクを作って開発担当に割り振り、開発担当はそのタスクを終える
      const title = `社長が作るタスク ${String(started)}`;
      await scriptReply(
        page,
        "president",
        [{ type: "tool_use", id: "toolu_flow_node_create", name: "mcp__staff__node_create", input: { kind: "task", parentId: PROJECT, title, body: "山が空の通しで社長が作った", taskKind: "build", assignee: "builder", repo: "example/know-office" } }],
        "tool_use",
      );
      await scriptReply(page, "president", [{ type: "text", text: "開発担当の次のタスクを作った" }], "end_turn");
      await scriptReply(page, "builder", [{ type: "text", text: "社長が作ったタスクを終えた" }], "end_turn");
      undo.unshift(() => forgetReplies(page, "president"), () => forgetReplies(page, "builder"));

      const restorePresident = await clockIn(page, "president");
      undo.unshift(() => restorePresident());
      // 開発担当を出勤させ直すと、手の空いた開発担当が山を見て、空なので上司に次を求める。勤務の時刻は社長の分を後で戻すので、こちらを先に戻す
      const restoreBuilder = await clockIn(page, "builder", true);
      undo.unshift(() => restoreBuilder());

      // 社長が作ったタスクが通しの木に足され、開発担当が取って終える
      const found: { id: string | null } = { id: null };
      await expect
        .poll(
          async () => {
            found.id =
              Trees.parse(await (await page.request.get(`/api/v1/nodes?rootId=${PURPOSE}`)).json())
                .data.flatMap(function walk(n: Tree): Tree[] {
                  return [n, ...n.children.flatMap(walk)];
                })
                .find((n) => n.title === title)?.id ?? null;
            return found.id !== null;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const nodeId = found.id ?? "";
      await expect.poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 }).toContainEqual({ staffId: "builder", nodeId });
      await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status, { timeout: 60_000 }).toBe("done");

      // 社長の「開発担当の次のタスクを作る」は、開発担当が求めた物で、社長が終えて済になる
      const plans = z.array(z.object({ id: z.string(), status: z.string() })).parse(
        readMain(`SELECT id, status FROM nodes WHERE source = 'ask_boss:builder' AND assignee = 'president' AND created_at >= ${String(started)} ORDER BY created_at LIMIT 1`),
      );
      expect(plans.map((p) => p.status)).toEqual(["done"]);
      await page.goto(`/staff/president/tasks/${plans[0]?.id ?? ""}`);
      await expect(page.getByRole("heading", { level: 2, name: PLAN_TITLE })).toBeVisible();
      await expect(part(page, "作業の流れ").getByText("finished", { exact: true })).toBeVisible();

      // 開発担当の仕事の山に、社長が作ったタスクが済で出る
      await page.goto("/staff/builder?tab=tasks");
      const row = page.getByRole("main").locator("li", { hasText: title }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText("済", { exact: true })).toBeVisible();
    }, undo);
  });
});
