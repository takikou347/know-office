// 設計書を同じ時に直す、2 つの PR を順に main に入れる所。条件がそろった時だけ、設計書を先に、コードを後に進める (開発の回し方の 3.6)
import { describe, expect, it } from "vitest";
import { DOCS, DOCS2, REPO, seedSetting } from "../helpers/docs.ts";
import { CODE_HEAD, DOCS_HEAD } from "../helpers/docs-together.ts";
import { BASE, child, detail, planOf, plan, rewriteDocs, issuesOf } from "../helpers/issues.ts";
import { approve as approveFor, retry as retryFor, reviewed as reviewedFor, statusOf as statusFor } from "../helpers/docs-land.ts";
import { rows, useWork } from "../helpers/work.ts";
import { eventsOf } from "../helpers/review.ts";

const world = useWork({ github: true });

const reviewed = () => reviewedFor(world);
const approve = () => approveFor(world);
const retry = (task: string) => retryFor(world, task);
const statusOf = (task: string) => statusFor(world, task);

/**
 * 通知の種類を読む
 * @returns 種類
 */
async function notices(): Promise<unknown[]> {
  return (await rows(world.d1.DB, "SELECT kind, level, scope FROM notices WHERE kind = 'devloop_split'")).map((r) => [r["kind"], r["level"]]);
}

describe("設計書を同じ時に直す", () => {
  it("設計書と一緒に入れる", async () => {
    const { task, number, repos } = await reviewed();
    expect(await approve()).toBe(true);
    // 設計書が先、コードが後
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`, `${REPO}:${CODE_HEAD}`]);
    expect(await statusOf(task)).toBe("done");
    expect(issuesOf(world).find((i) => i.number === number)).toMatchObject({ state: "closed", stateReason: "completed" });
  });

  it("片方だけでは入れない", async () => {
    const { task, repos } = await reviewed();
    repos.checks[DOCS] = "pending";
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([]);
    expect(await statusOf(task)).toBe("review");
    // 承認は同じ先に残っているので、押し直しで同じ答えになる。チェックが落ちていても入れない
    repos.checks[DOCS] = "failed";
    expect(await retry(task)).toBe(false);
    expect(repos.merges).toEqual([]);
    expect(await notices()).toEqual([]);
  });

  it("設計書だけが入る", async () => {
    const { task, repos } = await reviewed();
    // コードの main を進める更新が GitHub の失敗で断られる
    repos.broken.add(REPO);
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`]);
    expect(await statusOf(task)).toBe("review");
    expect(await notices()).toEqual([["devloop_split", "warn"]]);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM github_mirrors WHERE kind = 'issue_close'")).toEqual([{ n: 0 }]);
    expect((await eventsOf(world, task)).map((e) => e.kind)).toContain("devloop_split");
  });

  it("設計書が先に main に入っていればコードだけ進める", async () => {
    const { task, repos } = await reviewed();
    repos.broken.add(REPO);
    await approve();
    repos.broken.delete(REPO);
    expect(await retry(task)).toBe(true);
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`, `${REPO}:${CODE_HEAD}`]);
    expect(await statusOf(task)).toBe("done");
  });

  it("設計書を進めた後にコードが behind なら、設計書は残して作った社員に戻す", async () => {
    const { task, repos } = await reviewed();
    // 事前の確かめを通した後に main が進んだ
    repos.behind.add(REPO);
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`]);
    // 作った社員がすぐ取り直す (todo に戻って doing)
    expect(["todo", "doing"]).toContain(await statusOf(task));
    expect((await eventsOf(world, task)).map((e) => e.kind)).toEqual(expect.arrayContaining(["devloop_split"]));
    expect(await notices()).toEqual([["devloop_split", "warn"]]);
  });

  it("設計書が behind なら何も進めない", async () => {
    const { task, repos } = await reviewed();
    repos.behind.add(DOCS);
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([]);
    expect(["todo", "doing"]).toContain(await statusOf(task));
    expect((await eventsOf(world, task)).map((e) => e.kind)).toContain("main_advanced");
    expect(await notices()).toEqual([]);
  });

  it("コードが behind なら設計書を進めない", async () => {
    const { task, repos } = await reviewed();
    repos.stale.add(REPO);
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([]);
    expect(["todo", "doing"]).toContain(await statusOf(task));
    expect((await eventsOf(world, task)).map((e) => e.kind)).toContain("main_advanced");
  });

  it("設計書のリポジトリが変わった後は入れない", async () => {
    const { task, repos } = await reviewed();
    await seedSetting(world, "devloop.docs_repo", { repo: DOCS2 }, 2);
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([]);
    expect(await statusOf(task)).toBe("review");
    expect((await eventsOf(world, task)).map((e) => e.kind)).toContain("merge_refused");
  });

  it("確かめた先が無い設計書は入れない", async () => {
    const { task, repos } = await reviewed();
    await world.d1.DB.prepare("UPDATE reviews SET docs_head_sha = NULL WHERE node_id = ?").bind(task).run();
    expect(await approve()).toBe(false);
    expect(repos.merges).toEqual([]);
  });

  it("同じタスクを 2 度進めない", async () => {
    const { task, repos } = await reviewed();
    await world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve' WHERE node_id = ?").bind(task).run();
    const results = await Promise.allSettled([retry(task), retry(task)]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value)).toHaveLength(1);
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`, `${REPO}:${CODE_HEAD}`]);
  });

  it("設計書と一緒に入れた子は、合わせ直しで作り直さない", async () => {
    const { service, repos } = await reviewed();
    // 設計書の PR が要件の本文を変える。main に入った設計書も同じに置く
    const next = detail({ first: "文章と画像から作る" });
    repos.files[`${BASE}/1-video.md`] = next;
    expect(await approve()).toBe(true);
    rewriteDocs(world, "1-video.md", next);
    const again = await plan(world, planOf(service, [child("動画を作る", { kind: "chore" })]));
    expect(again.children.map((c) => c.created)).toEqual([false]);
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM dev_issues WHERE kind = 'child'")).toEqual([{ n: 1 }]);
  });
});
