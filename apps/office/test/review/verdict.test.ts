// オーナーがレビューで出した承認と差し戻しが、GitHub のプルリクエストのレビューに写る (タスクとレビューの 3.6、要件 review の know-office の中で確認する)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { wrapDb } from "../helpers/github.ts";
import { api, REPO, rows, useWork } from "../helpers/work.ts";
import { appForge, eventsOf, HEAD, marked, openReview, postedTo, sameBatch, spyBatches } from "../helpers/review.ts";
import { runTool } from "../../src/gate/work/tools.ts";

const world = useWork();

describe("know-office の中で確認する", () => {
  it("承認を出す", async () => {
    const { task } = await openReview(world);
    const data = await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "表の作りはよい", baseSha: HEAD });
    expect(data).toEqual({ nodeId: task, ownerVerdict: "approve" });
    // App が出したプルリクエストに App は可を付けられないので、GitHub が断った後は判断を頭に書いたレビューにする
    expect(postedTo(world, "reviews")).toEqual([
      { event: "APPROVE", body: marked("オーナー: 表の作りはよい"), commit_id: HEAD },
      { event: "COMMENT", body: marked("[承認] オーナー: 表の作りはよい"), commit_id: HEAD },
    ]);
    expect(await rows(world.d1.DB, "SELECT owner_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ owner_verdict: "approve" }]);
    expect(await rows(world.d1.DB, "SELECT kind, sent_at IS NOT NULL AS sent, github_id IS NOT NULL AS has_id FROM github_mirrors")).toEqual([{ kind: "review", sent: 1, has_id: 1 }]);
    expect(world.gate.audits.find((a) => a.action === "review.verdict")).toMatchObject({ actor: "owner", target: task, detail: { verdict: "approve" } });
  });

  it("App が出していないプルリクエストには、そのまま可を付ける", async () => {
    const { task } = await openReview(world);
    // 代わりの GitHub が App の出した物と覚えていない、オーナーが出したプルリクエストの 2 番にする
    await world.d1.DB.prepare("UPDATE reviews SET pr_number = 2 WHERE node_id = ?").bind(task).run();
    await world.d1.DB.prepare("UPDATE nodes SET pr_number = 2 WHERE id = ?").bind(task).run();
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: HEAD });
    const states = world.gate.github.sent.map((s) => z.object({ review: z.object({ state: z.string() }).loose() }).loose().parse(s.payload).review.state);
    expect(states).toEqual(["approved"]);
    expect(world.gate.github.requests.filter((r) => r.route === `POST /repos/${REPO}/pulls/2/reviews`)).toHaveLength(1);
  });

  it("差し戻しは GitHub に不可として写り、作った社員のタスクに戻る", async () => {
    const { task } = await openReview(world);
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "空の日の表が崩れる", baseSha: HEAD });
    expect(postedTo(world, "reviews")[0]).toEqual({ event: "REQUEST_CHANGES", body: marked("オーナー: 空の日の表が崩れる"), commit_id: HEAD });
    const events = await eventsOf(world, task);
    expect(events.find((e) => e.kind === "review_rejected")).toEqual({ kind: "review_rejected", staffId: null, detail: { by: "owner", summary: "空の日の表が崩れる" } });
    // 戻ったタスクは、手の空いた開発担当がすぐに取る
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
  });

  it("確かめた後に変更が足されていたら 409 で断り、GitHub に何も写さない", async () => {
    const { task } = await openReview(world);
    const problem = await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: "c".repeat(40) }, 409);
    expect(problem).toMatchObject({ code: "conflict" });
    expect(postedTo(world, "reviews")).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT owner_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ owner_verdict: null }]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM github_mirrors")).toEqual([{ n: 0 }]);
  });

  it("確かめる間に push が届いたら 409 で断り、GitHub に何も写さない", async () => {
    const { task } = await openReview(world);
    // 読んだ後、書く前に pull_request の synchronize が先を進める
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        await world.d1.DB.prepare("UPDATE reviews SET head_sha = ? WHERE node_id = ?").bind("d".repeat(40), task).run();
        return real(statements);
      },
    });
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: HEAD }, 409);
    } finally {
      restore();
    }
    expect(postedTo(world, "reviews")).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM github_mirrors")).toEqual([{ n: 0 }]);
  });

  it("無いレビューは 404", async () => {
    await openReview(world);
    expect(await api(world, "POST", `/api/v1/reviews/${crypto.randomUUID()}/verdict`, { verdict: "approve", body: "", baseSha: HEAD }, 404)).toMatchObject({ code: "not_found" });
  });

  it("差し戻しの判断と、作った社員のタスクを todo に戻すのは 1 回のバッチで書く", async () => {
    const { task } = await openReview(world);
    const spy = spyBatches(world);
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD });
    } finally {
      spy.restore();
    }
    expect(sameBatch(spy.batches, "UPDATE reviews SET owner_verdict", "INSERT INTO github_mirrors", "UPDATE nodes SET status = 'todo'")).toBe(true);
  });

  it("差し戻しの間に push が届いたら、タスクも戻さない", async () => {
    const { task } = await openReview(world);
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        await world.d1.DB.prepare("UPDATE reviews SET head_sha = ? WHERE node_id = ?").bind("d".repeat(40), task).run();
        return real(statements);
      },
    });
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "request_changes", body: "直す", baseSha: HEAD }, 409);
    } finally {
      restore();
    }
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
  });
});

describe("チェックが落ちたままのマージ", () => {
  it("オーナーが承認しても、要るチェックが落ちていれば main に入れずにタスクを止める", async () => {
    const { task } = await openReview(world);
    await world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve' WHERE node_id = ?").bind(task).run();
    world.gate.github.set(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }] });
    await api(world, "POST", `/api/v1/reviews/${task}/verdict`, { verdict: "approve", body: "よい", baseSha: HEAD });
    expect(world.gate.github.requests.filter((r) => r.route === `PATCH /repos/${REPO}/git/refs/heads/main`)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT scope, target, signal FROM stops")).toEqual([{ scope: "task", target: task, signal: "unchecked_merge" }]);
    expect((await eventsOf(world, task)).find((e) => e.kind === "merge_refused")).toMatchObject({ detail: { reason: "checks" } });
  });

  it("レビュー担当とオーナーの承認が同時に落ちたチェックを読んでも、止めた記録は 1 つ", async () => {
    const { task } = await openReview(world);
    world.gate.github.set(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }] });
    const [reviewer, owner] = await Promise.all([
      runTool(world.gate.env, appForge(world), { staffId: "reviewer", tool: "review_submit", input: { verdict: "approve", summary: "読んだ", headSha: HEAD }, now: world.clock.now(), guard: world.gate.deps }),
      world.gate.request(`/api/v1/reviews/${task}/verdict`, { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ verdict: "approve", body: "よい", baseSha: HEAD }) }),
    ]);
    expect(reviewer.isError).toBe(false);
    expect(owner.status).toBe(200);
    expect(await rows(world.d1.DB, "SELECT scope, target, signal FROM stops")).toEqual([{ scope: "task", target: task, signal: "unchecked_merge" }]);
    expect(world.gate.github.requests.filter((r) => r.route === `PATCH /repos/${REPO}/git/refs/heads/main`)).toEqual([]);
  });
});
