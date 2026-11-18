// 先が進んだ後と差し戻しの後に、レビュー担当のレビューのタスクを 1 つだけ立て直し、同じプルリクエストで確かめ直す (タスクとレビューの 3.1、GitHub の連携の 3.3、タスクとレビューの 3.2)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Forge } from "../../src/gate/work/loop.ts";
import { wrapDb } from "../helpers/github.ts";
import { appForge, buildTaken, HEAD, openReview, sameBatch, spyBatches } from "../helpers/review.ts";
import { AGAIN, branchOf, checksRunning, headOf, NEWER, NEXT, oneOpen, openReviewTasks, prOpened, pullsOpened, rejected, reviewerSays, setPullState, sqlOf, synchronize, tool } from "../helpers/review-again.ts";
import { RECHECK_AFTER_MS, recheckReviews } from "../../src/gate/work/review.ts";
import { api, REPO, rows, staffOf, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });

describe("別のモデルによる確認", () => {
  it("先が進んだら、レビュー担当がもう一度確かめる (synchronize とその場の直し)", async () => {
    const { c, task } = await openReview(world);
    checksRunning(world, HEAD, NEXT);
    await reviewerSays(world, "approve", HEAD);
    expect(await openReviewTasks(world)).toEqual([]);

    // 開発担当が push して先が進むと、レビュー担当のレビューのタスクが 1 つ立ち、すぐに取る
    await synchronize(world, c, NEXT);
    expect(await rows(world.d1.DB, "SELECT head_sha, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: NEXT, reviewer_verdict: null }]);
    const again = await openReviewTasks(world);
    expect(again).toEqual(oneOpen(1));
    expect(await staffOf(world, "reviewer").status(world.clock.now())).toMatchObject({ nodeId: again[0]?.["id"] });
    await reviewerSays(world, "approve", NEXT);

    // オーナーがその場で直してコミットしても、もう一度確かめる
    world.gate.github.heads.set(`${REPO}:${await branchOf(world, task)}`, NEXT);
    const { sha } = z.object({ sha: z.string() }).parse(await api(world, "POST", `/api/v1/reviews/${task}/commits`, { path: "src/a.ts", content: "export const a = 1;\n", baseSha: NEXT, message: "直す" }, 201));
    checksRunning(world, sha);
    expect(await rows(world.d1.DB, "SELECT head_sha, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: sha, reviewer_verdict: null }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));
    await reviewerSays(world, "approve", sha);
    expect(await openReviewTasks(world)).toEqual([]);
  });

  it("差し戻しの後は、同じプルリクエストで出し直す (openPull を呼ばず、reviews は 1 行、承認とチェックが消える)", async () => {
    const { task } = await openReview(world);
    await rejected(world, task);
    const branch = await branchOf(world, task);
    await world.d1.DB.prepare("UPDATE reviews SET checks = ?, owner_verdict = 'request_changes' WHERE node_id = ?").bind(JSON.stringify([{ name: "verify", ok: false }]), task).run();
    // 開発担当が直して push した。synchronize の通知はまだ届いていない
    world.gate.github.heads.set(`${REPO}:${branch}`, NEXT);
    expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false, content: JSON.stringify({ number: 1, branch }) });
    expect(pullsOpened(world)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT pr_number, head_sha, checks, reviewer_verdict, owner_verdict FROM reviews WHERE node_id = ?", task)).toEqual([
      { pr_number: 1, head_sha: NEXT, checks: "[]", reviewer_verdict: null, owner_verdict: null },
    ]);
    expect(await rows(world.d1.DB, "SELECT status, pr_number FROM nodes WHERE id = ?", task)).toEqual([{ status: "review", pr_number: 1 }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));
    expect(await prOpened(world, task)).toEqual([{ prNumber: 1, branch }, { prNumber: 1, branch, again: true }]);
  });

  it("差し戻しの後に先が同じまま出し直すと、チェックは残る", async () => {
    const { task } = await openReview(world);
    await rejected(world, task);
    const checks = JSON.stringify([{ name: "verify", ok: true }]);
    await world.d1.DB.prepare("UPDATE reviews SET checks = ? WHERE node_id = ?").bind(checks, task).run();
    expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false });
    expect(pullsOpened(world)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT head_sha, checks FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: HEAD, checks }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));
  });

  it("出し直す前にプルリクエストが閉じていたら、新しいプルリクエストで同じ行を直し、入っていたら断る", async () => {
    const { task } = await openReview(world);
    await rejected(world, task);
    const branch = await branchOf(world, task);
    setPullState(world, 1, "closed");
    world.gate.github.set(`POST /repos/${REPO}/pulls`, { number: 2, base: { sha: "a".repeat(40) }, head: { sha: NEXT } });
    expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false, content: JSON.stringify({ number: 2, branch }) });
    expect(pullsOpened(world)).toBe(2);
    expect(await rows(world.d1.DB, "SELECT pr_number, branch, head_sha, checks, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ pr_number: 2, branch, head_sha: NEXT, checks: "[]", reviewer_verdict: null }]);
    expect(await rows(world.d1.DB, "SELECT status, pr_number FROM nodes WHERE id = ?", task)).toEqual([{ status: "review", pr_number: 2 }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(2));

    // もう一度差し戻した後に、プルリクエストがもう main に入っていたら、何も書かずに断る
    await rejected(world, task, NEXT);
    setPullState(world, 2, "merged");
    const before = await rows(world.d1.DB, "SELECT * FROM reviews WHERE node_id = ?", task);
    await expect(tool(world, "builder", "pr_open", AGAIN)).rejects.toMatchObject({ code: "conflict" });
    expect(pullsOpened(world)).toBe(2);
    expect(await rows(world.d1.DB, "SELECT * FROM reviews WHERE node_id = ?", task)).toEqual(before);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    expect(await openReviewTasks(world)).toEqual([]);
  });

  it("プルリクエストを出した後に書き込みが落ちても、次の pr_open は同じプルリクエストで進む (初めてと、閉じた後の出し直し)", async () => {
    const { task } = await buildTaken(world);
    const failing = () => wrapDb(world, { batch: (real, statements) => real([...statements, world.d1.DB.prepare("INSERT INTO no_such_table VALUES (1)")]) });
    let restore = failing();
    try {
      await expect(tool(world, "builder", "pr_open", AGAIN)).rejects.toThrow(/no such table/);
    } finally {
      restore();
    }
    // GitHub には 1 番が開いたまま残る。もう一度出すと同じブランチの開いた PR として 422 で断られるので、開いた PR を読んで使う
    expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false, content: JSON.stringify({ number: 1, branch: await branchOf(world, task) }) });
    expect(pullsOpened(world)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT pr_number FROM reviews WHERE node_id = ?", task)).toEqual([{ pr_number: 1 }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));

    // 閉じた後の出し直しで、2 番を出した後に書き込みが落ちても、次は 2 番で進む
    await staffOf(world, "reviewer").pull(world.clock.now());
    await rejected(world, task);
    setPullState(world, 1, "closed");
    world.gate.github.set(`POST /repos/${REPO}/pulls`, { number: 2, base: { sha: "a".repeat(40) }, head: { sha: NEXT } });
    restore = failing();
    try {
      await expect(tool(world, "builder", "pr_open", AGAIN)).rejects.toThrow(/no such table/);
    } finally {
      restore();
    }
    expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false, content: JSON.stringify({ number: 2, branch: await branchOf(world, task) }) });
    expect(pullsOpened(world)).toBe(2);
    expect(await rows(world.d1.DB, "SELECT pr_number, checks, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ pr_number: 2, checks: "[]", reviewer_verdict: null }]);
    expect(await rows(world.d1.DB, "SELECT status, pr_number FROM nodes WHERE id = ?", task)).toEqual([{ status: "review", pr_number: 2 }]);
  });

  it("出し直しが GitHub を読む間に先が進んでも、新しい先を古い先で上書きしない", async () => {
    const { c, task } = await openReview(world);
    await rejected(world, task);
    world.gate.github.heads.set(`${REPO}:${await branchOf(world, task)}`, NEXT);
    const real = appForge(world);
    // GitHub が NEXT を返した後、書く前に、もう一度進んだ通知が届く
    const forge: Forge = {
      ...real,
      pullState: async (repo, pr) => {
        const state = await real.pullState(repo, pr);
        await synchronize(world, c, NEWER);
        return state;
      },
    };
    expect(await tool(world, "builder", "pr_open", AGAIN, forge)).toMatchObject({ isError: false });
    expect(await rows(world.d1.DB, "SELECT head_sha FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: NEWER }]);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));
  });

  it("pr_open の 2 度目 (タスクがもう review) は何も書かない", async () => {
    const { task } = await openReview(world);
    await rejected(world, task);
    world.gate.github.heads.set(`${REPO}:${await branchOf(world, task)}`, NEXT);
    const real = appForge(world);
    // 1 度目が GitHub を読む間に、2 度目が出し直しを終える
    const forge: Forge = {
      ...real,
      pullState: async (repo, pr) => {
        const state = await real.pullState(repo, pr);
        expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false });
        return state;
      },
    };
    await expect(tool(world, "builder", "pr_open", AGAIN, forge)).rejects.toMatchObject({ code: "conflict" });
    expect(pullsOpened(world)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT pr_number, head_sha FROM reviews WHERE node_id = ?", task)).toEqual([{ pr_number: 1, head_sha: NEXT }]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));
    expect((await prOpened(world, task)).length).toBe(2);
  });

  it("pullState が 404 の時は何も書かない", async () => {
    const { task } = await openReview(world);
    await rejected(world, task);
    const before = await rows(world.d1.DB, "SELECT * FROM reviews WHERE node_id = ?", task);
    world.gate.github.failNext(`GET /repos/${REPO}/pulls/1`, 404);
    await expect(tool(world, "builder", "pr_open", AGAIN)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(pullsOpened(world)).toBe(1);
    expect(await rows(world.d1.DB, "SELECT * FROM reviews WHERE node_id = ?", task)).toEqual(before);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    expect(await openReviewTasks(world)).toEqual([]);
  });

  it("pr_open が先に先を写した後の同じ先の通知では、レビューのタスクを足さない", async () => {
    const { c, task } = await openReview(world);
    await rejected(world, task);
    world.gate.github.heads.set(`${REPO}:${await branchOf(world, task)}`, NEXT);
    expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false });
    checksRunning(world, NEXT);
    await reviewerSays(world, "approve", NEXT);
    expect(await openReviewTasks(world)).toEqual([]);
    // 開発担当の push の通知が、出し直しの後に遅れて届く
    await synchronize(world, c, NEXT);
    expect(await openReviewTasks(world)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT head_sha, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: NEXT, reviewer_verdict: "approve" }]);
  });

  it("確かめ直しを同時に 2 度求めても、レビューのタスクは 1 つ (synchronize とその場の直しの同時を含む)", async () => {
    const { c, task } = await openReview(world);
    checksRunning(world, HEAD, NEXT, NEWER);
    await reviewerSays(world, "approve", HEAD);
    // 続けて 2 つ push した通知が同時に届く
    await Promise.all([synchronize(world, c, NEXT), synchronize(world, c, NEWER)]);
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));
    const head = await headOf(world, task);
    await reviewerSays(world, "approve", head);
    expect(await openReviewTasks(world)).toEqual([]);

    // オーナーのその場の直しが先を進める間に、同じコミットの synchronize の通知が先に届く
    const branch = await branchOf(world, task);
    world.gate.github.heads.set(`${REPO}:${branch}`, head);
    let sent = false;
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        if (!sent && sqlOf(statements[0]).startsWith("UPDATE reviews SET head_sha = ?, checks = '[]', owner_verdict = NULL")) {
          sent = true;
          await synchronize(world, c, world.gate.github.heads.get(`${REPO}:${branch}`) ?? "");
        }
        return real(statements);
      },
    });
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/commits`, { path: "src/a.ts", content: "export const a = 1;\n", baseSha: head, message: "直す" }, 201);
    } finally {
      restore();
    }
    expect(sent).toBe(true);
    expect(await headOf(world, task)).toBe(world.gate.github.heads.get(`${REPO}:${branch}`));
    expect(await openReviewTasks(world)).toEqual(oneOpen(1));

    // その場の直しのコミットの後、バッチの前に同じ先の通知が届き、レビュー担当がその先を承認して閉じても、承認済みの先にタスクを足さない
    const fixed = await headOf(world, task);
    checksRunning(world, fixed);
    await reviewerSays(world, "approve", fixed);
    let approved = false;
    const again = wrapDb(world, {
      batch: async (real, statements) => {
        if (!approved && sqlOf(statements[0]).startsWith("UPDATE reviews SET head_sha = ?, checks = '[]', owner_verdict = NULL")) {
          approved = true;
          const pushed = world.gate.github.heads.get(`${REPO}:${branch}`) ?? "";
          checksRunning(world, pushed);
          await synchronize(world, c, pushed);
          await reviewerSays(world, "approve", pushed);
        }
        return real(statements);
      },
    });
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/commits`, { path: "src/a.ts", content: "export const a = 2;\n", baseSha: fixed, message: "もう一度直す" }, 201);
    } finally {
      again();
    }
    expect(approved).toBe(true);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ reviewer_verdict: "approve" }]);
    expect(await openReviewTasks(world)).toEqual([]);
  });

  it("レビュー担当が差し戻しを出す間に出し直されても、確かめ直しが残る (C の競り合い)", async () => {
    const { task } = await openReview(world);
    const [first] = await openReviewTasks(world);
    let reopened: unknown = null;
    // 差し戻しを書いた直後、レビュー担当がタスクを離れる前に、開発担当が直して出し直す
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        const out = await real(statements);
        if (reopened === null && sqlOf(statements[0]).startsWith("UPDATE reviews SET reviewer_verdict")) {
          await staffOf(world, "builder").pull(world.clock.now());
          reopened = await tool(world, "builder", "pr_open", AGAIN);
        }
        return out;
      },
    });
    try {
      await reviewerSays(world, "reject", HEAD);
    } finally {
      restore();
    }
    expect(reopened).toMatchObject({ isError: false });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "review" }]);
    const open = await openReviewTasks(world);
    expect(open).toEqual(oneOpen(1));
    expect(open[0]?.["id"]).not.toBe(first?.["id"]);
  });

  it("途中で落ちたら何も残らない (バッチの spy)、定期の確かめが取りこぼしを拾い、10 分より新しい物は拾わない", async () => {
    const { c, task } = await openReview(world);
    checksRunning(world, HEAD, NEXT);
    await reviewerSays(world, "approve", HEAD);

    // 先を進める事、承認を消す事 (コードの先と、結んだ設計書の先)、レビューのタスクを足す事は、受けた記録より前に 1 回のバッチで書く
    const spy = spyBatches(world);
    try {
      await synchronize(world, c, NEXT);
    } finally {
      spy.restore();
    }
    const hookBatch = spy.batches.find((b) => b.some((q) => q.startsWith("INSERT OR IGNORE INTO github_deliveries"))) ?? [];
    expect(hookBatch.map((q) => q.slice(0, 26))).toEqual(["UPDATE reviews SET owner_v", "UPDATE reviews SET owner_v", 'insert into "nodes" ("id",', "INSERT OR IGNORE INTO gith"]);
    await reviewerSays(world, "reject", NEXT);

    // 出し直しのバッチの最後の文が落ちると、タスクの移しもレビューの行もレビューのタスクも残らない
    const before = await rows(world.d1.DB, "SELECT * FROM reviews WHERE node_id = ?", task);
    world.gate.github.heads.set(`${REPO}:${await branchOf(world, task)}`, NEWER);
    const restore = wrapDb(world, { batch: (real, statements) => real([...statements, world.d1.DB.prepare("INSERT INTO no_such_table VALUES (1)")]) });
    try {
      await expect(tool(world, "builder", "pr_open", AGAIN)).rejects.toThrow(/no such table/);
    } finally {
      restore();
    }
    expect(await rows(world.d1.DB, "SELECT * FROM reviews WHERE node_id = ?", task)).toEqual(before);
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    expect(await openReviewTasks(world)).toEqual([]);

    // 出し直しの 3 つの文は同じバッチに入る
    const spied = spyBatches(world);
    try {
      expect(await tool(world, "builder", "pr_open", AGAIN)).toMatchObject({ isError: false });
    } finally {
      spied.restore();
    }
    expect(sameBatch(spied.batches, "UPDATE nodes SET status = 'review'", "UPDATE reviews SET checks", 'insert into "nodes"')).toBe(true);

    // レビューのタスクの出来事と知らせの前に落ちて、タスクが消えた時の取りこぼしを、定期の確かめが拾う
    const at = world.clock.now();
    await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE task_kind = 'review' AND status IN ('todo', 'doing')").run();
    expect(await recheckReviews(world.gate.env, at + RECHECK_AFTER_MS - 1)).toBe(0);
    expect(await openReviewTasks(world)).toEqual([]);
    expect(await recheckReviews(world.gate.env, at + RECHECK_AFTER_MS + 1)).toBe(1);
    expect(await recheckReviews(world.gate.env, at + RECHECK_AFTER_MS + 2)).toBe(0);
    expect((await openReviewTasks(world)).length).toBe(1);
  });

  it("判断の後に main に入れる所で GitHub が落ちても、レビュー担当は閉じたレビューのタスクを離れる", async () => {
    await openReview(world);
    const [first] = await openReviewTasks(world);
    world.gate.github.failNext(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, 500);
    await expect(tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "確かめた", headSha: HEAD })).rejects.toMatchObject({ code: "upstream_failed" });
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", first?.["id"])).toEqual([{ status: "done" }]);
    expect(await staffOf(world, "reviewer").status(world.clock.now())).toMatchObject({ nodeId: null });
  });
});
