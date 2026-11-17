// 設計書を同じ時に直す、設計書の PR を出して結ぶ所。同じサービスの設計書を直す別のタスクがある間は出せず、結ぶのは同じタスクで出した PR だけ (開発の回し方の 3.6)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DOCS, DOCS2, failure, seedSetting, synchronize } from "../helpers/docs.ts";
import { DOCS_HEAD, DOCS_NEXT, otherTask, working } from "../helpers/docs-together.ts";
import { advance, at, rows, staffOf, tool, useWork } from "../helpers/work.ts";
import { claimDocs } from "../../src/gate/devloop/docs-link.ts";

const world = useWork({ github: true });

/**
 * ツールの答えから PR の番号を読む
 * @param content 答えの本文
 * @returns 番号
 */
function numbered(content: string): { number: number } {
  return z.object({ number: z.number() }).parse(JSON.parse(content));
}

/**
 * 設計書の PR を出す
 * @param name ブランチの名前
 * @returns ツールの答え
 */
function openDocs(name = "spec") {
  return tool(world, "builder", "docs_pr_open", { name, title: "設計書を直す", body: "" });
}

/**
 * コードの PR を出す
 * @param docsPr 結ぶ設計書の PR の番号
 * @returns ツールの答え
 */
function openCode(docsPr?: number) {
  return tool(world, "builder", "pr_open", { name: "make", title: "動画を作る", body: "", ...(docsPr === undefined ? {} : { docsPr }) });
}

/**
 * task_docs の行を読む
 * @returns 行
 */
function docsRows() {
  return rows(world.d1.DB, "SELECT node_id, pr_number, branch FROM task_docs ORDER BY created_at");
}

describe("設計書を同じ時に直す", () => {
  it("設計書の直しが無い", async () => {
    const { task } = await working(world);
    // 役目の説明文に、決まった一句が入っている
    const prompt = await rows(world.d1.DB, "SELECT s.prompt_version AS v, p.body FROM staff s JOIN staff_prompts p ON p.staff_id = s.id AND p.version = s.prompt_version WHERE s.id = 'reviewer'");
    expect(prompt[0]?.v).toBe(2);
    expect(String(prompt[0]?.body)).toContain("仕様が変わったのに、コードの PR が設計書の PR を docsPr で結んでいなければ差し戻す");
    // 結ばずに出したコードの PR を差し戻すと todo に戻り、設計書の PR を足して結んで出し直すと review になる
    expect(await openCode()).toMatchObject({ isError: false });
    await advance(world, at(10));
    await staffOf(world, "reviewer").pull(world.clock.now());
    expect(await tool(world, "reviewer", "review_submit", { verdict: "reject", summary: "仕様が変わったのに設計書の PR が無い", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    // 開発担当がすぐ取り直す
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    const docs = numbered((await openDocs()).content);
    expect(await openCode(docs.number)).toMatchObject({ isError: false });
    expect(await rows(world.d1.DB, "SELECT n.status, r.docs_head_sha FROM nodes n JOIN reviews r ON r.node_id = n.id WHERE n.id = ?", task)).toEqual([{ status: "review", docs_head_sha: DOCS_HEAD }]);
  });

  it("設計書の直しが重なる", async () => {
    const { task, repos } = await working(world);
    const other = await otherTask(world, task, "doing");
    const error = await failure(openDocs());
    expect(error.code).toBe("conflict");
    expect(repos.opened).toEqual([]);
    expect(await docsRows()).toHaveLength(1);
    // 1 つ目が済めば取れる
    await world.d1.DB.prepare("UPDATE nodes SET status = 'done' WHERE id = ?").bind(other).run();
    expect(await openDocs()).toMatchObject({ isError: false });
    expect(repos.opened).toEqual([`${DOCS}:ko/${task.slice(0, 8)}-spec`]);
  });

  it.each(["todo", "waiting_owner", "stopped", "review"])("持ち主が %s の間も 2 つ目は取れない", async (status) => {
    const { task, repos } = await working(world);
    await otherTask(world, task, status);
    expect((await failure(openDocs())).code).toBe("conflict");
    expect(repos.opened).toEqual([]);
  });

  it.each(["done", "dropped"])("持ち主が %s なら 2 つ目は取れる", async (status) => {
    const { task } = await working(world);
    await otherTask(world, task, status);
    expect(await openDocs()).toMatchObject({ isError: false });
  });

  it("同時に取りに来ても 1 つだけ", async () => {
    const { task, service } = await working(world);
    const other = await otherTask(world, task, "doing", false);
    const claim = (node: string) => claimDocs(world.gate.env.DB, { nodeId: node, serviceId: service, repo: DOCS, branch: `ko/${node.slice(0, 8)}-spec`, now: 1 });
    const results = await Promise.all([claim(task), claim(other)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await docsRows()).toHaveLength(1);
  });

  it("2 度目の docs_pr_open は新しい PR を出さない", async () => {
    const { repos } = await working(world);
    const first = numbered((await openDocs()).content);
    repos.heads.set(`${DOCS}:${repos.opened[0]?.split(":")[1] ?? ""}`, DOCS_NEXT);
    const second = numbered((await openDocs("other-name")).content);
    expect(second.number).toBe(first.number);
    expect(repos.opened).toHaveLength(1);
  });

  it("行の PR が main に入っていれば、新しいブランチで出し直して行を替える", async () => {
    const { task, repos } = await working(world);
    await openDocs();
    repos.landed.add(`${DOCS}:${DOCS_HEAD}`);
    // 同じ name は同じブランチなので断り、別の name なら新しい PR を出す
    expect((await failure(openDocs())).code).toBe("validation_failed");
    expect(await openDocs("spec-two")).toMatchObject({ isError: false });
    expect(repos.opened).toHaveLength(2);
    expect(await docsRows()).toEqual([{ node_id: task, pr_number: 12, branch: `ko/${task.slice(0, 8)}-spec-two` }]);
  });

  it("設計書の PR を出した後に落ちても、次の呼びで同じ PR を使う", async () => {
    const { task, repos, } = await working(world);
    const real = world.forge.openPull.bind(world.forge);
    world.forge.openPull = async (input) => {
      await real(input);
      throw new Error("PR を出した後に落ちた");
    };
    await expect(openDocs()).rejects.toThrow("PR を出した後に落ちた");
    // 行は残り、PR の番号はまだ無い
    expect(await docsRows()).toEqual([{ node_id: task, pr_number: null, branch: `ko/${task.slice(0, 8)}-spec` }]);
    world.forge.openPull = real;
    expect(await openDocs()).toMatchObject({ isError: false });
    expect(repos.opened).toHaveLength(1);
    expect(await docsRows()).toEqual([{ node_id: task, pr_number: 11, branch: `ko/${task.slice(0, 8)}-spec` }]);
  });

  it("出す前の確かめで断った時だけ行を消す", async () => {
    const { repos } = await working(world);
    world.forge.changedPaths = () => Promise.resolve(["services/other-app/README.md"]);
    expect((await failure(openDocs())).code).toBe("validation_failed");
    expect(repos.opened).toEqual([]);
    expect(await docsRows()).toEqual([]);
  });

  it("出す前の確かめで断っても、PR を出した後の行は消さない", async () => {
    const { task, repos } = await working(world);
    // PR を出した後に落ちて、行は番号の無いまま PR だけ GitHub に開いている
    const real = world.forge.openPull.bind(world.forge);
    world.forge.openPull = async (input) => {
      await real(input);
      throw new Error("PR を出した後に落ちた");
    };
    await expect(openDocs()).rejects.toThrow("PR を出した後に落ちた");
    world.forge.openPull = real;
    world.forge.changedPaths = () => Promise.resolve(["services/other-app/README.md"]);
    expect((await failure(openDocs())).code).toBe("validation_failed");
    expect(await docsRows()).toEqual([{ node_id: task, pr_number: null, branch: `ko/${task.slice(0, 8)}-spec` }]);
    expect(repos.opened).toHaveLength(1);
  });

  it("main に入った PR を新しいブランチに替えた後に断っても、替えた行は消さない", async () => {
    const { task, repos } = await working(world);
    expect(await openDocs()).toMatchObject({ isError: false });
    repos.landed.add(`${DOCS}:${DOCS_HEAD}`);
    world.forge.changedPaths = () => Promise.resolve(["services/other-app/README.md"]);
    expect((await failure(openDocs("second"))).code).toBe("validation_failed");
    expect(await docsRows()).toEqual([{ node_id: task, pr_number: null, branch: `ko/${task.slice(0, 8)}-second` }]);
  });

  it("別のタスクの設計書の PR は結べない", async () => {
    const { task } = await working(world);
    const docs = numbered((await openDocs()).content);
    // 行が無い番号と、ほかのタスクの番号
    expect((await failure(openCode(999))).code).toBe("validation_failed");
    await otherTask(world, task, "done");
    await world.d1.DB.prepare("UPDATE task_docs SET pr_number = 77 WHERE pr_number = 90").run();
    expect((await failure(openCode(77))).code).toBe("validation_failed");
    // 行があるのに docsPr が無い
    expect((await failure(openCode())).code).toBe("validation_failed");
    expect(await openCode(docs.number)).toMatchObject({ isError: false });
  });

  it("別のサービスの置き場を変える設計書の PR は結べない", async () => {
    await working(world);
    const docs = numbered((await openDocs()).content);
    world.forge.changedPaths = () => Promise.resolve(["services/other-app/docs/01-overview/index.md"]);
    expect((await failure(openCode(docs.number))).code).toBe("validation_failed");
  });

  it("設計書のリポジトリが変わった後は結べない", async () => {
    await working(world);
    const docs = numbered((await openDocs()).content);
    await seedSetting(world, "devloop.docs_repo", { repo: DOCS2 }, 2);
    expect((await failure(openCode(docs.number))).code).toBe("conflict");
  });

  it("設計書の PR に push すると承認が消える", async () => {
    const { task } = await working(world);
    const docs = numbered((await openDocs()).content);
    expect(await openCode(docs.number)).toMatchObject({ isError: false });
    await world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve', checks = '[{\"name\":\"verify\",\"ok\":true}]' WHERE node_id = ?").bind(task).run();
    await synchronize(world, DOCS, DOCS_HEAD, docs.number);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict, docs_head_sha FROM reviews WHERE node_id = ?", task)).toEqual([{ reviewer_verdict: "approve", docs_head_sha: DOCS_HEAD }]);
    await synchronize(world, DOCS, DOCS_NEXT, docs.number);
    expect(await rows(world.d1.DB, "SELECT reviewer_verdict, docs_head_sha, checks FROM reviews WHERE node_id = ?", task)).toEqual([{ reviewer_verdict: null, docs_head_sha: DOCS_NEXT, checks: "[]" }]);
  });
});
