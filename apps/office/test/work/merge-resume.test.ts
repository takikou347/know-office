// main に入れる途中で Worker が止まった時に、done のまま残るタスクを定期の確かめが拾う事を確かめる (タスクとレビューの 3.1 の 5、開発の回し方の 3.6)
import { describe, expect, it } from "vitest";
import { RESUME_AFTER_MS, RESUME_LIMIT, RESUME_TRIES, resumeMerges } from "../../src/gate/work/merge-resume.ts";
import { DOCS, REPO } from "../helpers/docs.ts";
import { CODE_HEAD, DOCS_HEAD } from "../helpers/docs-together.ts";
import { reviewed, statusOf } from "../helpers/docs-land.ts";
import { issuesOf } from "../helpers/issues.ts";
import { GitHubRateLimited } from "../../src/gate/github/rate-error.ts";
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
    world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve', merge_started_at = ?2, merge_started_sha = ?3 WHERE node_id = ?1").bind(made.task, now, CODE_HEAD),
    world.d1.DB.prepare("UPDATE nodes SET status = 'done', version = version + 1, updated_at = ? WHERE id = ?").bind(now, made.task),
    world.d1.DB.prepare("INSERT INTO github_mirrors (id, review_id, kind, payload, created_at, attempts) VALUES ('stale-close', ?, 'issue_close', ?, ?, 0)").bind(review?.["id"], JSON.stringify({ issueNumber: made.number, sha: CODE_HEAD }), now),
  ]);
  return { ...made, now };
}

/**
 * 入れ始めたまま止まったタスクを、main に入っていない形で n 件足す。入れ始めた時刻は古い順に並ぶ
 * @param n 件数
 * @param sha 確かめたコミットの 1 字
 */
async function seed(n: number, sha: string): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const id = `019a7b00-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;
    await world.d1.DB.batch([
      world.d1.DB.prepare("INSERT INTO nodes (id, kind, scope, title, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES (?, 'task', 'office', '勤怠', 'build', 'builder', 'done', 1, ?, ?, ?, 'president', 1, ?)").bind(id, REPO, `ko/${String(i)}`, 100 + i, i + 1),
      world.d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, merge_started_at, merge_started_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(`r-${id}`, id, REPO, 100 + i, `ko/${String(i)}`, "a".repeat(40), sha.repeat(40), i + 1, sha.repeat(40)),
    ]);
  }
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
    // 戻した時に入れ始めた印も消える
    expect(await rows(world.d1.DB, "SELECT merge_started_at AS at, merge_started_sha AS sha FROM reviews WHERE node_id = ?", task)).toEqual([{ at: null, sha: null }]);
    // 落ちたチェックのままの求めでも、定期の入れ直しは社員の求めでないので、自動停止に数えない
    expect(await rows(world.d1.DB, "SELECT id FROM stops")).toEqual([]);
    expect(world.gate.deps.rollbacks).toEqual([]);
    // 未送信の閉じの順番待ちは消えている (Issue はまだ閉じない)
    expect(await rows(world.d1.DB, "SELECT id FROM github_mirrors WHERE kind = 'issue_close'")).toEqual([]);
  });

  it("入れ直せずに戻した後に差し戻され、社員が終えた done は拾わない", async () => {
    const { task, repos, now } = await stopped();
    repos.checks[REPO] = "failed";
    const at = now + RESUME_AFTER_MS + 1;
    await resume(at);
    expect(await statusOf(world, task)).toBe("review");
    // オーナーが差し戻して社員が直し、同じ先のまま finishTask で done にした形
    repos.checks[REPO] = "passed";
    await world.d1.DB.prepare("UPDATE nodes SET status = 'done', version = version + 1, updated_at = ? WHERE id = ?").bind(at, task).run();
    expect(await resume(at + RESUME_AFTER_MS + 1)).toBe(0);
    expect(await statusOf(world, task)).toBe("done");
    expect(repos.merges).toEqual([]);
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
    await seed(RESUME_LIMIT, "c");
    // main に入っていない 20 件は、承認が無いので review に戻って待つ。21 件目 (入れ始めた時刻が一番新しい物) は次の回に残る
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(RESUME_LIMIT);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM nodes WHERE status = 'review' AND id LIKE '019a7b00-%'")).toEqual([{ n: RESUME_LIMIT }]);
    expect(await statusOf(world, task)).toBe("done");
  });

  it("入れ始めた印の無い done と、出し直しの後の done は拾わない", async () => {
    const { task, repos, now } = await stopped();
    // 社員が finishTask で終えた物や、差し戻しの後に終えた物は印を持たない
    await world.d1.DB.prepare("UPDATE reviews SET merge_started_at = NULL WHERE node_id = ?").bind(task).run();
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(0);
    // 入れ始めた後に出し直して、先が変わった物も拾わない
    await world.d1.DB.prepare("UPDATE reviews SET merge_started_at = ?, head_sha = ? WHERE node_id = ?").bind(now, "d".repeat(40), task).run();
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(0);
    expect(await statusOf(world, task)).toBe("done");
    expect(repos.merges).toEqual([]);
  });

  it("1 件が落ちても残りを続ける", async () => {
    const { task, repos, now } = await stopped();
    await seed(1, "c");
    world.forge.inMain = (repo, sha) => (sha === "c".repeat(40) ? Promise.reject(new Error("GitHub を読めない")) : Promise.resolve(repos.landed.has(`${repo}:${sha}`)));
    const at = now + RESUME_AFTER_MS + 1;
    expect(await resume(at)).toBe(1);
    expect(repos.merges).toHaveLength(2);
    expect(await statusOf(world, task)).toBe("done");
    // 落ちた行は回数を数え、次に試す時刻を後ろへ回す
    expect(await rows(world.d1.DB, "SELECT merge_tries AS tries, merge_retry_at > ? AS later FROM reviews WHERE head_sha = ?", at, "c".repeat(40))).toEqual([{ tries: 1, later: 1 }]);
  });

  it("落ち続ける行が先頭を塞がない", async () => {
    const { task, now, repos } = await stopped();
    await seed(RESUME_LIMIT, "c");
    let failing = 0;
    world.forge.inMain = (repo, sha) => (sha === "c".repeat(40) ? (failing += 1, Promise.reject(new Error("GitHub を読めない"))) : Promise.resolve(repos.landed.has(`${repo}:${sha}`)));
    const at = now + RESUME_AFTER_MS + 1;
    // 1 回目は古い 20 件が落ちて上限を使い切る。2 回目は後ろへ回した 20 件を飛ばし、後ろに居たタスクに届く
    expect(await resume(at)).toBe(0);
    expect(failing).toBe(RESUME_LIMIT);
    expect(await resume(at)).toBe(1);
    expect(failing).toBe(RESUME_LIMIT);
    expect(await statusOf(world, task)).toBe("done");
  });

  it("続けて落ちた行は諦めて 1 回だけ知らせる", async () => {
    const { now, repos } = await stopped();
    await seed(1, "c");
    world.forge.inMain = (repo, sha) => (sha === "c".repeat(40) ? Promise.reject(new Error("GitHub を読めない")) : Promise.resolve(repos.landed.has(`${repo}:${sha}`)));
    let at = now + RESUME_AFTER_MS + 1;
    for (let n = 0; n < RESUME_TRIES + 3; n += 1) {
      await resume(at);
      at += RESUME_TRIES * RESUME_AFTER_MS;
    }
    expect(await rows(world.d1.DB, "SELECT merge_tries AS tries, merge_started_at AS started FROM reviews WHERE head_sha = ?", "c".repeat(40))).toEqual([{ tries: RESUME_TRIES, started: null }]);
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'merge_resume_gave_up'")).toHaveLength(1);
  });

  it("GitHub の上限に当たったら残りを試さず通知に任せる", async () => {
    const { now } = await stopped();
    await seed(2, "c");
    let reads = 0;
    world.forge.inMain = () => (reads += 1, Promise.reject(new GitHubRateLimited(30)));
    expect(await resume(now + RESUME_AFTER_MS + 1)).toBe(0);
    expect(reads).toBe(1);
    expect(await rows(world.d1.DB, "SELECT SUM(merge_tries) AS n FROM reviews")).toEqual([{ n: 0 }]);
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'github_rate_limited'")).toHaveLength(1);
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
