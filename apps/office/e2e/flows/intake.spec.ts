// 途中からタスクを足す通し。オーナーが会話で社長に話しかけると、社長が分けるタスクが受け付けに入り、社長が代わりの Claude で node_create を呼んでレビュー担当に割り振り、レビュー担当が取って終える。ゲートウェイの返事は差し替えない (タスクとレビューの 3.1 の 7)
import { expect, test } from "../helpers/test.ts";
import { settle } from "./helpers/settle.ts";
import { clockIn, forgetReplies, ownerPasskey, scriptReply, staffNow } from "./helpers/staff.ts";
import { column, dropTodos, finishedBy, GOAL, openTree, PROJECT, releaseHeld, sayTo, scriptFinish, taskCard, type Tree, Trees } from "./helpers/staff-work.ts";

/**
 * 出勤させる前に落ちた時の戻し。何もしない
 * @returns すぐ解ける約束
 */
function noRestore(): Promise<void> {
  return Promise.resolve();
}

test.describe("目的からタスクまでの木", () => {
  test("途中からタスクを足す", async ({ page }) => {
    // 社長とレビュー担当が 1 度ずつ SDK を呼ぶのを待つ
    test.slow();
    await openTree(page);
    await ownerPasskey(page);
    const stamp = String(Date.now());
    const asked = `勤怠を週ごとにも見たい ${stamp}`;
    const split = `週ごとの勤怠の表 ${stamp}`;
    let restore: () => Promise<void> = noRestore;
    await settle(
      async () => {
        // 勤務の外なら出勤させる。手の空いた社長への発言は、すぐ取る分けるタスクになる
        restore = await clockIn(page, "president");
        // 前の通しの残りと、山が空の部下が足した分けるタスクに、積んだ返事を取られないようにする。走っている社長への発言は今の呼び出しに渡るので、持ったままのタスクも空ける
        for (const staffId of ["president", "reviewer"]) {
          await forgetReplies(page, staffId);
          await dropTodos(page, staffId);
          await releaseHeld(page, staffId);
        }
        await dropTodos(page, "president");
        await expect.poll(async () => (await staffNow(page, "president")).nodeId, { timeout: 30_000 }).toBeNull();
        await scriptReply(
          page,
          "president",
          [{ type: "tool_use", id: "toolu_flow_split", name: "mcp__staff__node_create", input: { kind: "task", parentId: PROJECT, title: split, body: "社長が分けた", taskKind: "build", assignee: "reviewer", repo: "example/know-office" } }],
          "tool_use",
        );
        await scriptReply(page, "president", [{ type: "text", text: "分けて割り振った" }], "end_turn");
        await scriptFinish(page);

        // 社長の会話で話しかけると、発言の下にタスクにした印と、分けるタスクへの道が出る
        const bubble = await sayTo(page, "president", "社長", `${asked}\n週の合計が欲しい`);
        await expect(bubble.getByText("タスクにしました")).toBeVisible();
        const link = bubble.getByRole("link", { name: "タスクを開く" });
        const href = (await link.getAttribute("href")) ?? "";
        const planId = href.split("/").at(-1) ?? "";
        expect(href).toBe(`/staff/president/tasks/${planId}`);

        // 社長が分けるタスクを取り、レビュー担当に割り振って終える
        await finishedBy(page, planId, "president");
        const found = Trees.parse(await (await page.request.get(`/api/v1/nodes?rootId=${PROJECT}`)).json())
          .data.flatMap(function walk(n: Tree): Tree[] {
            return [n, ...n.children.flatMap(walk)];
          })
          .find((n) => n.title === split);
        expect(found).toBeDefined();
        // 割り振られたレビュー担当が取って終える
        await finishedBy(page, found?.id ?? "");

        // 会話の道から分けるタスクを開くと、発言の 1 行目が題になっている
        await page.goto("/staff/president?tab=talk");
        await page.getByRole("log", { name: "社長との会話" }).getByRole("listitem").filter({ hasText: asked }).getByRole("link", { name: "タスクを開く" }).click();
        await expect(page.getByRole("heading", { level: 2, name: asked })).toBeVisible();

        // 目標の画面で、割り振られたタスクは通しの目標の、受け付けの分けるタスクは受け付けの完了の列に出る
        await page.goto(`/goals/${GOAL}`);
        await expect(taskCard(page, split, column(page, "完了"))).toBeVisible();
        await page.goto("/goals");
        await page.getByRole("main").getByRole("link", { name: "受け付け", exact: true }).first().click();
        await expect(taskCard(page, asked, column(page, "完了"))).toBeVisible();
      },
      // 山が空になったレビュー担当が足す分けるタスクを、社長に持たせたまま残さない
      [() => forgetReplies(page, "president"), () => forgetReplies(page, "reviewer"), () => releaseHeld(page, "president"), () => dropTodos(page, "president"), () => restore()],
    );
  });
});
