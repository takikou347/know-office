// 5 分ごとの確かめ直しが、レビューを割り振れない組 (作った社員とレビュー担当が同じモデル) を拾わず、上限の件数を食わない事を確かめる (タスクとレビューの 3.4)
import { describe, expect, it } from "vitest";
import { RECHECK_AFTER_MS, recheckReviews } from "../../src/gate/work/review.ts";
import { REPO, rows, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * レビューを待つ作ったタスクとレビューの行を、レビュー担当の確かめ直しが要る形で置く
 * @param n 何番目か。ID とプルリクエストの番号に使う
 * @param assignee 作った社員
 * @param at 最後に動いた時刻
 */
async function waitingReview(n: number, assignee: string, at: number): Promise<void> {
  const id = `019a7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  await world.d1.DB.batch([
    world.d1.DB.prepare(
      "INSERT INTO nodes (id, kind, scope, title, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES (?, 'task', 'office', '勤怠', 'build', ?, 'review', 1, ?, ?, ?, 'president', ?, ?)",
    ).bind(id, assignee, REPO, `ko/${String(n)}`, n, at, at),
    world.d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(`r-${id}`, id, REPO, n, `ko/${String(n)}`, "a".repeat(40), "b".repeat(40)),
  ]);
}

describe("別のモデルによる確認", () => {
  it("定期の確かめ直しは、作った社員とレビュー担当が同じモデルの組を拾わず、上限の 50 件を食わない", async () => {
    const at = world.clock.now();
    // 社長はレビュー担当と同じモデルなので、その社長が作った 50 件はレビューを割り振れない。その後ろに開発担当が作った 1 件を置く
    for (let n = 1; n <= 50; n += 1) await waitingReview(n, "president", at);
    await waitingReview(51, "builder", at);
    expect(await recheckReviews(world.gate.env, at + RECHECK_AFTER_MS + 1)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT pr_number FROM nodes WHERE task_kind = 'review' AND status = 'todo'")).toEqual([{ pr_number: 51 }]);
  });
});
