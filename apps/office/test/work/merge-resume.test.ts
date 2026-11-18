// main に入れる途中で Worker が止まった時に、done のまま残るタスクを定期の確かめが拾う事を確かめる (タスクとレビューの 3.1 の 5、開発の回し方の 3.6)
import { describe, expect, it } from "vitest";
import { RESUME_AFTER_MS, RESUME_LIMIT, resumeMerges } from "../../src/gate/work/merge-resume.ts";
import { DOCS, REPO } from "../helpers/docs.ts";
import { CODE_HEAD, DOCS_HEAD } from "../helpers/docs-together.ts";
import { reviewed, statusOf } from "../helpers/docs-land.ts";
import { issuesOf } from "../helpers/issues.ts";
import { rows, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });

/**
 * 設計書とコードの PR を承認まで進め、タスクを done にした後で Worker が止まった形にする。main にはまだ何も入っていない
 * 子 Issue を閉じる順番待ちは、done にする文と同じバッチで積まれた形で置く
 * @returns タスク ID、Issue の番号、代わりの GitHub の記録、止まった時刻
 */
async function stopped() {
  const made = await reviewed(world);
  const now = world.clock.now();
  const [review] = await rows(world.d1.DB, "SELECT id FROM reviews WHERE node_id = ?", made.task);
  await world.d1.DB.batch([
    world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve' WHERE node_id = ?").bind(made.task),
    world.d1.DB.prepare("UPDATE nodes SET status = 'done', version = version + 1, updated_at = ? WHERE id = ?").bind(now, made.task),
    world.d1.DB.prepare("INSERT INTO github_mirrors (id, review_id, kind, payload, created_at, attempts) VALUES ('stale-close', ?, 'issue_close', ?, ?, 0)").bind(review?.["id"], JSON.stringify({ issueNumber: made.number, sha: CODE_HEAD }), now),
  ]);
  return { ...made, now };
}

/**
 * 定期の確かめを 1 回走らせる
 * @param now 今の時刻
 * @returns 入れ直しや印の書き直しをした数
 */
async function resume(now: number): Promise<number> {
  return resumeMerges(world.gate.env, world.forge, world.gate.deps, now);
}

/**
 * mergedAt を読む
 * @param task タスク ID
 * @returns 入れた時刻。無ければ null
 */
async function mergedAt(task: string): Promise<unknown> {
  return (await rows(world.d1.DB, "SELECT merged_at FROM reviews WHERE node_id = ?", task))[0]?.["merged_at"];
}

describe("タスクの繰り返し", () => {
  it("done にした後に止まったタスクを入れ直す", async () => {
    const { task, number, repos, now } = await stopped();
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(1);
    // 設計書が先、コードが後。入れた後に印と Issue の閉じも残る
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`, `${REPO}:${CODE_HEAD}`]);
    expect(await statusOf(world, task)).toBe("done");
    expect(await mergedAt(task)).toBe(now + RESUME_AFTER_MS + 1);
    expect(issuesOf(world).find((i) => i.number === number)).toMatchObject({ state: "closed", stateReason: "completed" });
    // 積み直した閉じの順番待ちが 1 つだけ送られている。前に積んだ物は残らない
    expect(await rows(world.d1.DB, "SELECT id FROM github_mirrors WHERE kind = 'issue_close' AND sent_at IS NOT NULL")).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT id FROM github_mirrors WHERE id = 'stale-close'")).toEqual([]);
    // 次の確かめは何もしない
    expect(await resume(now + 2 * RESUME_AFTER_MS)).toBe(0);
    expect(repos.merges).toHaveLength(2);
  });

  it("main に入っているのに done のまま残ったタスクは入った印だけ書く", async () => {
    const { task, repos, now } = await stopped();
    repos.landed.add(`${DOCS}:${DOCS_HEAD}`);
    repos.landed.add(`${REPO}:${CODE_HEAD}`);
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(1);
    expect(repos.merges).toEqual([]);
    expect(await statusOf(world, task)).toBe("done");
    expect(await mergedAt(task)).toBe(now + RESUME_AFTER_MS + 1);
    // 閉じの順番待ちは消さず、定期の送り直しに任せる
    expect(await rows(world.d1.DB, "SELECT id FROM github_mirrors WHERE id = 'stale-close'")).toHaveLength(1);
  });

  it("止まってから 10 分たつまでは戻さない", async () => {
    const { task, repos, now } = await stopped();
    expect(await resume(now + RESUME_AFTER_MS)).toBe(0);
    expect(await statusOf(world, task)).toBe("done");
    expect(repos.merges).toEqual([]);
    expect(await mergedAt(task)).toBeNull();
  });

  it("入れ直せない時は review のまま残す", async () => {
    const { task, repos, now } = await stopped();
    repos.checks[REPO] = "failed";
    await resume(now + RESUME_AFTER_MS + 1);
    expect(repos.merges).toEqual([]);
    expect(await statusOf(world, task)).toBe("review");
    expect(await mergedAt(task)).toBeNull();
    // 未送信の閉じの順番待ちは消えている (Issue はまだ閉じない)
    expect(await rows(world.d1.DB, "SELECT id FROM github_mirrors WHERE kind = 'issue_close'")).toEqual([]);
  });

  it("同時に拾っても 1 度だけ入れる", async () => {
    const { task, repos, now } = await stopped();
    const at = now + RESUME_AFTER_MS + 1;
    await Promise.all([resume(at), resume(at)]);
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`, `${REPO}:${CODE_HEAD}`]);
    expect(await statusOf(world, task)).toBe("done");
  });

  it("1 回に拾うのは 20 件まで", async () => {
    const { task, now } = await stopped();
    // 同じ行を写した止まったタスクを足して 21 件にする。古い順に拾うので、最初のタスクが後ろになる
    for (let n = 0; n < RESUME_LIMIT; n += 1) {
      const id = `019a7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
      await world.d1.DB.batch([
        world.d1.DB.prepare("INSERT INTO nodes (id, kind, scope, title, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES (?, 'task', 'office', '勤怠', 'build', 'builder', 'done', 1, ?, ?, ?, 'president', 1, ?)").bind(id, REPO, `ko/${String(n)}`, 100 + n, n + 1),
        world.d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").bind(`r-${id}`, id, REPO, 100 + n, `ko/${String(n)}`, "a".repeat(40), "c".repeat(40)),
      ]);
    }
    // main に入っていない 20 件は、承認が無いので review に戻って待つ。21 件目 (最後に変えた物) は次の回に残る
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(RESUME_LIMIT);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM nodes WHERE status = 'review' AND id LIKE '019a7b00-%'")).toEqual([{ n: RESUME_LIMIT }]);
    expect(await statusOf(world, task)).toBe("done");
  });
});

describe("設計書を同じ時に直す", () => {
  it("設計書だけ入った後に止まったタスクはコードだけ入れ直す", async () => {
    const { task, repos, now } = await stopped();
    // 設計書は先に入り、コードを進める前に止まった
    repos.landed.add(`${DOCS}:${DOCS_HEAD}`);
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(1);
    expect(repos.merges).toEqual([`${REPO}:${CODE_HEAD}`]);
    expect(await statusOf(world, task)).toBe("done");
    expect(await mergedAt(task)).not.toBeNull();
  });
});
