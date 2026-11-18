// 承認の後にチェックを待つタスクを、チェックの終わりの通知と GitHub で出たオーナーの可で main に入れる (タスクとレビューの 3.1 の 5、GitHub の連携の 3.4)
import { describe, expect, it } from "vitest";
import { RESUME_AFTER_MS, resumeMerges } from "../../src/gate/work/merge-resume.ts";
import { type Connected, hook, wrapDb } from "../helpers/github.ts";
import { appForge, eventsOf, HEAD, openReview, reviewHook } from "../helpers/review.ts";
import { checksRunning, NEXT, reviewerSays } from "../helpers/review-again.ts";
import { REPO, rows, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });

/** main を進める要求 */
const MAIN = `PATCH /repos/${REPO}/git/refs/heads/main`;

/**
 * 先のチェックの一覧を置く
 * @param sha 先
 * @param runs チェックの名前と状態と結果
 */
function checks(sha: string, runs: [string, string, string | null][]): void {
  world.gate.github.set(`GET /repos/${REPO}/commits/${sha}/check-runs`, { total_count: runs.length, check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })) });
}

/**
 * 開発担当が PR を出し、チェックが走っている間にレビュー担当が承認した所まで進める。main を進める返事も置く
 * @returns 連携とタスク
 */
async function approvedWhileRunning(): Promise<{ c: Connected; task: string }> {
  const { c, task } = await openReview(world);
  checksRunning(world, HEAD);
  world.gate.github.set(MAIN, { ref: "refs/heads/main", object: { sha: HEAD } });
  await reviewerSays(world, "approve", HEAD);
  expect(await statusOf(task)).toBe("review");
  return { c, task };
}

/**
 * チェックの終わりの通知を送る
 * @param c 連携
 * @param event check_suite か check_run
 * @param sha 先
 * @param name check_run の名前
 * @param conclusion check_run の結果
 */
async function completed(c: Connected, event: "check_suite" | "check_run", sha: string = HEAD, name = "verify", conclusion = "success"): Promise<void> {
  const payload =
    event === "check_suite"
      ? { action: "completed", check_suite: { head_sha: sha, conclusion }, repository: { full_name: REPO }, installation: { id: c.installationId } }
      : { action: "completed", check_run: { name, status: "completed", conclusion, head_sha: sha }, repository: { full_name: REPO }, installation: { id: c.installationId } };
  expect((await hook(world, { event, payload, secret: c.webhookSecret })).status).toBe(204);
}

/**
 * タスクの状態を読む
 * @param task タスク ID
 * @returns 状態
 */
async function statusOf(task: string): Promise<unknown> {
  return (await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task))[0]?.["status"];
}

/**
 * main を進めた要求の本文
 * @returns 本文
 */
function merges(): unknown[] {
  return world.gate.github.requests.filter((r) => r.route === MAIN).map((r) => r.body);
}

describe("通知を受ける", () => {
  it("承認の後にチェックが通ったら、通知で main に入れる", async () => {
    const { c, task } = await approvedWhileRunning();
    checks(HEAD, [["verify", "completed", "success"]]);
    await completed(c, "check_suite");
    expect(merges()).toEqual([{ sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
    expect((await eventsOf(world, task)).filter((e) => e.kind === "merged")).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT merge_retry_at AS retry, merged_at IS NOT NULL AS merged FROM reviews WHERE node_id = ?", task)).toEqual([{ retry: null, merged: 1 }]);
  });

  it("チェックが走っている間の通知では入れず、出来事も足さない", async () => {
    const { c, task } = await approvedWhileRunning();
    const before = (await eventsOf(world, task)).length;
    // 1 本目が終わっても、ほかが走っている間は待つ
    checks(HEAD, [["lint", "completed", "success"], ["verify", "in_progress", null]]);
    await completed(c, "check_run", HEAD, "lint");
    expect(merges()).toEqual([]);
    expect(await eventsOf(world, task)).toHaveLength(before);
    // 待つ時は拾い直しの印も残さない
    expect(await rows(world.d1.DB, "SELECT merge_retry_at AS retry, merge_started_sha AS sha FROM reviews WHERE node_id = ?", task)).toEqual([{ retry: null, sha: null }]);
    // 最後の 1 本が終わった check_run の通知で入れる
    checks(HEAD, [["lint", "completed", "success"], ["verify", "completed", "success"]]);
    await completed(c, "check_run", HEAD, "verify");
    expect(merges()).toEqual([{ sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
  });

  it("承認の後にチェックが落ちたら、review のまま、オーナーに 1 回だけ知らせる", async () => {
    const { c, task } = await approvedWhileRunning();
    // ほかが走っている間の 1 本目の失敗は、まだ落ちたとしない
    checks(HEAD, [["lint", "completed", "failure"], ["verify", "in_progress", null]]);
    await completed(c, "check_run", HEAD, "lint", "failure");
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'checks_failed'")).toEqual([]);
    // 全部終わってから落ちたと決める。社員は呼ばず、自動停止にも数えない
    checks(HEAD, [["lint", "completed", "failure"], ["verify", "completed", "success"]]);
    await completed(c, "check_run", HEAD, "verify");
    await completed(c, "check_suite", HEAD, "", "failure");
    expect(merges()).toEqual([]);
    expect(await statusOf(task)).toBe("review");
    expect(await rows(world.d1.DB, "SELECT level, scope FROM notices WHERE kind = 'checks_failed'")).toEqual([{ level: "warn", scope: "office" }]);
    expect((await eventsOf(world, task)).filter((e) => e.kind === "checks_failed")).toEqual([{ kind: "checks_failed", staffId: null, detail: { sha: HEAD } }]);
    expect(await rows(world.d1.DB, "SELECT id FROM stops")).toEqual([]);
    // 知らせを読んだ後も、同じ先では足さない
    await world.d1.DB.prepare("UPDATE notices SET read_at = 1 WHERE kind = 'checks_failed'").run();
    await completed(c, "check_run", HEAD, "lint", "failure");
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'checks_failed'")).toHaveLength(1);
  });

  it("同時に届いた通知と承認でも、main には 1 度だけ入れる", async () => {
    const { c, task } = await openReview(world);
    checks(HEAD, [["verify", "completed", "success"]]);
    world.gate.github.set(MAIN, { ref: "refs/heads/main", object: { sha: HEAD } });
    // 承認を書いた後、入れる前に、2 本の通知がそれぞれ入れに行く
    await Promise.all([reviewerSays(world, "approve", HEAD), completed(c, "check_suite"), completed(c, "check_run")]);
    await Promise.all([completed(c, "check_suite", HEAD, "", "neutral"), completed(c, "check_run", HEAD, "lint")]);
    expect(merges()).toEqual([{ sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
    expect((await eventsOf(world, task)).filter((e) => e.kind === "merged")).toHaveLength(1);
  });

  it("承認の無いタスクと、古い先のタスクは通知で入れない", async () => {
    const { c, task } = await openReview(world);
    checks(HEAD, [["verify", "completed", "success"]]);
    checks(NEXT, [["verify", "completed", "success"]]);
    world.gate.github.set(MAIN, { ref: "refs/heads/main", object: { sha: HEAD } });
    await completed(c, "check_suite");
    expect(merges()).toEqual([]);
    // 承認した後でも、ほかの先の通知では入れない
    await world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve' WHERE node_id = ?").bind(task).run();
    await completed(c, "check_suite", NEXT);
    expect(merges()).toEqual([]);
    expect(await statusOf(task)).toBe("review");
  });

  it("チェックの通知の途中に push が届くと、古い先を入れず、承認も残らない", async () => {
    const { c, task } = await approvedWhileRunning();
    checks(HEAD, [["verify", "completed", "success"]]);
    // done にする文の直前に、synchronize と同じく先を進めて承認を消す (nodes の版は進まない)
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        if (statements.some((s) => JSON.stringify(s).includes("SET status = 'done'"))) {
          await world.d1.DB.prepare("UPDATE reviews SET head_sha = ?, reviewer_verdict = NULL, owner_verdict = NULL, checks = '[]' WHERE node_id = ?").bind(NEXT, task).run();
        }
        return real(statements);
      },
    });
    try {
      await completed(c, "check_suite");
    } finally {
      restore();
    }
    expect(merges()).toEqual([]);
    expect(await statusOf(task)).toBe("review");
    expect(await rows(world.d1.DB, "SELECT head_sha, reviewer_verdict, merge_started_at FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: NEXT, reviewer_verdict: null, merge_started_at: null }]);
  });

  it("入れる途中の GitHub の読みが落ちても、定期が入れ直す", async () => {
    const { c, task } = await approvedWhileRunning();
    checks(HEAD, [["verify", "completed", "success"]]);
    world.gate.github.failNext(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, 500);
    await completed(c, "check_suite");
    expect(merges()).toEqual([]);
    expect(await statusOf(task)).toBe("review");
    const now = world.clock.now();
    expect(await rows(world.d1.DB, "SELECT merge_retry_at AS retry, merge_started_sha AS sha FROM reviews WHERE node_id = ?", task)).toEqual([{ retry: now + RESUME_AFTER_MS, sha: HEAD }]);
    // 10 分たつまでは拾わない
    expect(await resumeMerges(world.gate.env, appForge(world), world.gate.deps, now + RESUME_AFTER_MS - 1)).toBe(0);
    expect(await resumeMerges(world.gate.env, appForge(world), world.gate.deps, now + RESUME_AFTER_MS)).toBe(1);
    expect(merges()).toEqual([{ sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
  });

  it("main を進める所で GitHub が落ちたら、review に戻して merge_failed を残し、定期の入れ直しが入れる", async () => {
    const { c, task } = await approvedWhileRunning();
    checks(HEAD, [["verify", "completed", "success"]]);
    world.gate.github.failNext(MAIN, 500);
    await completed(c, "check_suite");
    expect(await statusOf(task)).toBe("review");
    expect((await eventsOf(world, task)).filter((e) => e.kind === "merge_failed")).toEqual([{ kind: "merge_failed", staffId: null, detail: { sha: HEAD, code: "upstream_failed" } }]);
    const now = world.clock.now();
    expect(await resumeMerges(world.gate.env, appForge(world), world.gate.deps, now + RESUME_AFTER_MS)).toBe(1);
    expect(merges()).toEqual([{ sha: HEAD, force: false }, { sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
  });

  it("GitHub で出たオーナーの可で、条件がそろえば main に入れる", async () => {
    const { c, task } = await approvedWhileRunning();
    // チェックの終わりの通知を取りこぼした後に、オーナーが GitHub の画面で可を出す
    checks(HEAD, [["verify", "completed", "success"]]);
    expect((await hook(world, { event: "pull_request_review", payload: reviewHook(c, "approved", "よい"), secret: c.webhookSecret })).status).toBe(204);
    expect(merges()).toEqual([{ sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
    const kinds = (await eventsOf(world, task)).map((e) => e.kind);
    expect(kinds.slice(kinds.indexOf("owner_approved"))).toEqual(["owner_approved", "merged"]);
  });

  it("GitHub で出たオーナーの可の途中で GitHub のチェックを読めなくても、可は残り、定期が入れ直す", async () => {
    const { c, task } = await approvedWhileRunning();
    checks(HEAD, [["verify", "completed", "success"]]);
    world.gate.github.failNext(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, 500);
    expect((await hook(world, { event: "pull_request_review", payload: reviewHook(c, "approved", "よい"), secret: c.webhookSecret })).status).toBe(204);
    expect(merges()).toEqual([]);
    expect(await statusOf(task)).toBe("review");
    expect((await eventsOf(world, task)).filter((e) => e.kind === "owner_approved")).toHaveLength(1);
    const now = world.clock.now();
    expect(await rows(world.d1.DB, "SELECT owner_verdict AS owner, merge_retry_at AS retry, merge_started_sha AS sha FROM reviews WHERE node_id = ?", task)).toEqual([{ owner: "approve", retry: now + RESUME_AFTER_MS, sha: HEAD }]);
    expect(await resumeMerges(world.gate.env, appForge(world), world.gate.deps, now + RESUME_AFTER_MS)).toBe(1);
    expect(merges()).toEqual([{ sha: HEAD, force: false }]);
    expect(await statusOf(task)).toBe("done");
  });
});
