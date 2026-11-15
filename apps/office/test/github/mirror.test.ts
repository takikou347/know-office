// know-office のレビューと GitHub のプルリクエストのレビューを互いに写す。自分が写した物の通知は写し返さず、写せない時は記録に残して 5 分ごとに写し直す (タスクとレビューの 3.5、3.6)
import { describe, expect, it } from "vitest";
import { retryMirrors } from "../../src/gate/github/mirror.ts";
import { runScheduled } from "../../src/gate/jobs/health.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { hook, wrapDb } from "../helpers/github.ts";
import { fakeTracker } from "../helpers/weekly.ts";
import { api, MINUTE, REPO, rows, useWork } from "../helpers/work.ts";
import { commentHook, deliverSent, eventsOf, HEAD, openReview, postedTo, reviewHook } from "../helpers/review.ts";

const world = useWork();

/**
 * レビューの行のうち、写した判断と指摘を読む
 * @param task タスク ID
 * @returns オーナーの判断と、指摘の数
 */
async function reviewState(task: string): Promise<{ verdict: unknown; notes: unknown }> {
  const [row] = await rows(world.d1.DB, "SELECT owner_verdict FROM reviews WHERE node_id = ?", task);
  const [notes] = await rows(world.d1.DB, "SELECT count(*) AS n FROM review_notes");
  return { verdict: row?.["owner_verdict"], notes: notes?.["n"] };
}

describe("GitHub に写す", () => {
  it("レビュー担当の判断も App の名前で GitHub に写る", async () => {
    const { forge } = await openReview(world);
    const res = await runTool(world.gate.env, forge, { staffId: "reviewer", tool: "review_submit", input: { verdict: "reject", summary: "空の日の表のテストが無い" }, now: world.clock.now(), guard: world.gate.deps });
    expect(res.isError).toBe(false);
    expect(postedTo(world, "reviews")[0]).toEqual({ event: "REQUEST_CHANGES", body: "空の日の表のテストが無い", commit_id: HEAD });
  });

  it("レビューと行のコメントは、そのリポジトリの pull_requests の書きだけに絞った鍵で写す", async () => {
    const { task } = await openReview(world);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    await api(world, "POST", `/api/v1/reviews/${task}/notes`, { path: "src/a.ts", line: 1, side: "new", body: "ここ" }, 201);
    const posts = world.gate.github.requests.filter((r) => /^POST \/repos\/[^/]+\/[^/]+\/pulls\/1\/(reviews|comments)$/.test(r.route));
    // 不可は App の出したプルリクエストなので GitHub が断り、コメントのレビューで出し直す
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      const t = world.gate.github.tokens.get(p.token ?? "");
      expect(t?.repos).toEqual([REPO]);
      expect(t?.permissions).toEqual({ pull_requests: "write" });
    }
  });

  it("自分が写したレビューと行のコメントの通知は、know-office に写し返さない", async () => {
    const { c, task } = await openReview(world);
    // App が出していない 2 番のプルリクエストにして、GitHub が可をそのまま受ける形にする
    await world.d1.DB.prepare("UPDATE reviews SET pr_number = 2 WHERE node_id = ?").bind(task).run();
    await world.d1.DB.prepare("UPDATE nodes SET pr_number = 2 WHERE id = ?").bind(task).run();
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: HEAD });
    await api(world, "POST", `/api/v1/reviews/${task}/notes`, { path: "src/a.ts", line: 1, side: "new", body: "ここ" }, 201);
    // 写した後にオーナーが know-office で差し戻しに変えても、前に写した可の通知で戻らない
    await world.d1.DB.prepare("UPDATE reviews SET owner_verdict = 'request_changes' WHERE node_id = ?").bind(task).run();
    const before = { state: await reviewState(task), events: (await eventsOf(world, task)).length };
    const states = world.gate.github.sent.map((s) => s.event);
    expect(states).toEqual(["pull_request_review", "pull_request_review_comment"]);
    expect(await deliverSent(world, c)).toEqual([204, 204]);
    expect({ state: await reviewState(task), events: (await eventsOf(world, task)).length }).toEqual(before);
    expect(world.gate.github.requests.filter((r) => /\/pulls\/2\/(reviews|comments)$/.test(r.route))).toHaveLength(2);
  });

  it("App の名前で書かれた物は、持ち主の印と人の種類が付いていても写さない", async () => {
    const { c, task } = await openReview(world);
    const slug = [...world.gate.github.apps.values()].at(-1)?.slug ?? "";
    const app = { login: `${slug}[bot]`, type: "User" };
    await hook(world, { event: "pull_request_review", payload: { ...reviewHook(c, "changes_requested", "直す"), review: { id: 9002, state: "changes_requested", body: "直す", user: app, author_association: "OWNER" } }, secret: c.webhookSecret });
    const comment = commentHook(c, "ここ");
    await hook(world, { event: "pull_request_review_comment", payload: { ...comment, comment: { ...comment.comment, user: app } }, secret: c.webhookSecret });
    expect(await reviewState(task)).toEqual({ verdict: null, notes: 0 });
  });

  it("GitHub でオーナーが出した不可を、know-office のレビューに写して作った社員のタスクに戻す", async () => {
    const { c, task } = await openReview(world);
    expect((await hook(world, { event: "pull_request_review", payload: reviewHook(c, "changes_requested", "命名を直す"), secret: c.webhookSecret })).status).toBe(204);
    expect((await reviewState(task)).verdict).toBe("request_changes");
    const events = await eventsOf(world, task);
    expect(events.find((e) => e.kind === "review_rejected")).toEqual({ kind: "review_rejected", staffId: null, detail: { by: "owner", summary: "命名を直す", githubReviewId: 9001 } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    // GitHub から来た物は GitHub に写し直さない
    expect(postedTo(world, "reviews")).toEqual([]);
  });

  it("GitHub でオーナーが出した可を、know-office のレビューに写す", async () => {
    const { c, task } = await openReview(world);
    await hook(world, { event: "pull_request_review", payload: reviewHook(c, "approved", ""), secret: c.webhookSecret });
    expect((await reviewState(task)).verdict).toBe("approve");
    expect((await eventsOf(world, task)).find((e) => e.kind === "owner_approved")).toEqual({ kind: "owner_approved", staffId: null, detail: { by: "owner", summary: "", githubReviewId: 9001 } });
  });

  it("GitHub でオーナーが書いた行のコメントを、指摘として写して作った社員のタスクに戻す", async () => {
    const { c, task } = await openReview(world);
    await hook(world, { event: "pull_request_review_comment", payload: commentHook(c, "ここは 0 を返す"), secret: c.webhookSecret });
    expect(await rows(world.d1.DB, "SELECT by, path, line, side, body, github_comment_id FROM review_notes")).toEqual([{ by: "owner", path: "src/attendance.ts", line: 12, side: "new", body: "ここは 0 を返す", github_comment_id: 9100 }]);
    expect((await eventsOf(world, task)).find((e) => e.kind === "review_note")).toMatchObject({ staffId: null, detail: { by: "owner", path: "src/attendance.ts", line: 12, side: "new", body: "ここは 0 を返す" } });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    expect(postedTo(world, "comments")).toEqual([]);
  });

  it("同じ行のコメントの通知が配信 ID を替えて 2 度届いても、指摘は 1 つ", async () => {
    const { c } = await openReview(world);
    await hook(world, { event: "pull_request_review_comment", payload: commentHook(c, "ここ"), secret: c.webhookSecret });
    await hook(world, { event: "pull_request_review_comment", payload: { ...commentHook(c, "ここ"), sender: { login: "example", type: "User", id: 2 } }, secret: c.webhookSecret });
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM review_notes")).toEqual([{ n: 1 }]);
  });

  it("持ち主でない者のレビューと行のコメントは写さない", async () => {
    const { c, task } = await openReview(world);
    for (const association of ["NONE", "CONTRIBUTOR", "COLLABORATOR"]) {
      await hook(world, { event: "pull_request_review", payload: reviewHook(c, "approved", association, association), secret: c.webhookSecret });
      await hook(world, { event: "pull_request_review_comment", payload: commentHook(c, association, association), secret: c.webhookSecret });
    }
    expect(await reviewState(task)).toEqual({ verdict: null, notes: 0 });
  });

  it("GitHub が失敗したら記録に残し、5 分ごとのジョブが写し直す", async () => {
    const { task, forge } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/comments`, 502);
    await api(world, "POST", `/api/v1/reviews/${task}/notes`, { path: "src/a.ts", line: 1, side: "new", body: "ここ" }, 201);
    expect(await rows(world.d1.DB, "SELECT attempts, sent_at FROM github_mirrors")).toEqual([{ attempts: 1, sent_at: null }]);
    expect(await rows(world.d1.REC_2026, "SELECT code FROM error_events")).toEqual([{ code: "github_mirror_failed" }]);
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 1, failed: 0 });
    expect(await rows(world.d1.DB, "SELECT attempts, sent_at IS NOT NULL AS sent FROM github_mirrors")).toEqual([{ attempts: 2, sent: 1 }]);
    expect(postedTo(world, "comments")).toHaveLength(2);
    // 写し終えた物は 2 度写さない
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 0, failed: 0 });
    expect(postedTo(world, "comments")).toHaveLength(2);
  });

  it("5 分ごとの定期ジョブが、写せなかった物を App の鍵で写し直す", async () => {
    const { task } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/comments`, 503);
    await api(world, "POST", `/api/v1/reviews/${task}/notes`, { path: "src/a.ts", line: 1, side: "new", body: "ここ" }, 201);
    world.clock.advance(5 * MINUTE);
    const waits: Promise<unknown>[] = [];
    runScheduled(world.gate.env, { waitUntil: (p) => void waits.push(p) }, world.clock, { fetch: world.gate.fetch, tracker: fakeTracker() });
    await Promise.all(waits);
    expect(await rows(world.d1.DB, "SELECT sent_at IS NOT NULL AS sent FROM github_mirrors")).toEqual([{ sent: 1 }]);
    expect(world.gate.github.sent.map((s) => s.event)).toEqual(["pull_request_review_comment"]);
  });

  it("写し直しが同時に 2 つ走っても、GitHub には 1 度だけ写す", async () => {
    const { task, forge } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 500);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    world.clock.advance(5 * MINUTE);
    const results = await Promise.all([retryMirrors(world.gate.env, forge, world.clock), retryMirrors(world.gate.env, forge, world.clock)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    // GitHub が受けたレビューは 1 つだけ
    expect(world.gate.github.sent).toHaveLength(1);
  });

  it("写し直しが送る間に別の写し直しが来ても、同じ行を 2 度送らない", async () => {
    const { task, forge } = await openReview(world);
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 500);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    world.clock.advance(5 * MINUTE);
    // 1 つ目の写し直しが送る間に、2 つ目が同じ行を取ろうとする
    let inner: Promise<{ sent: number; failed: number }> | null = null;
    const restore = wrapDb(world, {
      prepare: (real, sql) => {
        if (inner === null && sql.startsWith("UPDATE github_mirrors SET github_id")) inner = retryMirrors(world.gate.env, forge, world.clock);
        return real(sql);
      },
    });
    try {
      await retryMirrors(world.gate.env, forge, world.clock);
    } finally {
      restore();
    }
    expect(await (inner ?? Promise.resolve({ sent: -1, failed: -1 }))).toEqual({ sent: 0, failed: 0 });
    expect(world.gate.github.sent).toHaveLength(1);
  });

  it("写し直しを 12 回続けて失敗したら、あきらめて記録に残す", async () => {
    const { task, forge } = await openReview(world);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    await world.d1.DB.prepare("UPDATE github_mirrors SET sent_at = NULL, attempts = 11, github_id = NULL").run();
    world.gate.github.failNext(`POST /repos/${REPO}/pulls/1/reviews`, 500);
    world.clock.advance(5 * MINUTE);
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 0, failed: 1 });
    expect(await retryMirrors(world.gate.env, forge, world.clock)).toEqual({ sent: 0, failed: 0 });
    expect((await rows(world.d1.REC_2026, "SELECT code FROM error_events")).map((r) => r["code"])).toContain("github_mirror_gave_up");
  });
});
