// サービスの Issue の木 (GET /api/v1/services/{serviceId}/issues)。親、子、同じ番号のタスク、設計書の PR、サービスに進められるか (開発の回し方の 3.7)
import { describe, expect, it } from "vitest";
import { ServiceIssues } from "@know-office/core";
import { child, plan, planOf, withDocs } from "../helpers/issues.ts";
import { clockIn, api, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });

/**
 * 木を読む
 * @param id サービス ID
 * @returns 返った木
 */
async function tree(id: string): Promise<ServiceIssues> {
  return ServiceIssues.parse(await api(world, "GET", `/api/v1/services/${id}/issues`));
}

/**
 * 設計書から親 1 件と子 2 件を作る
 * @returns サービス ID と番号
 */
async function planned() {
  const id = await withDocs(world);
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await clockIn(world, "president", "builder", "reviewer");
  const made = await plan(world, planOf(id, [child("動画を作る", { kind: "feature" }), child("動画を見る", { kind: "bug" })]));
  return { id, parent: made.parents[0]?.number ?? 0, kids: made.children.map((c) => c.number) };
}

describe("リリースと運用につなぐ", () => {
  it("設計書より前のサービスは空の木を返す", async () => {
    const id = await withDocs(world);
    expect(await tree(id)).toEqual({ ready: false, docsPrs: [], parents: [] });
  });

  it("存在しないサービスは 404", async () => {
    expect(await api(world, "GET", "/api/v1/services/0198c0de-0000-7000-8000-000000000000/issues", undefined, 404)).toMatchObject({ code: "not_found" });
  });

  it("親の下に子を番号順に並べ、子には同じ番号のタスクの状態を付ける", async () => {
    const { id, parent, kids } = await planned();
    const got = await tree(id);
    expect(got.ready).toBe(false);
    expect(got.parents).toHaveLength(1);
    expect(got.parents[0]).toMatchObject({ number: parent, feature: "1-video", state: "open", operations: false });
    expect(got.parents[0]?.children.map((c) => [c.number, c.requirement, c.kind, c.state])).toEqual([
      [kids[0], "動画を作る", "feature", "open"],
      [kids[1], "動画を見る", "bug", "open"],
    ]);
    expect(got.parents[0]?.children.every((c) => c.task !== null && c.task.prNumber === null)).toBe(true);
  });

  it("全部閉じた親は閉じ、入れて閉じたなら ready になる。外れて閉じただけなら ready にならない", async () => {
    const { id, kids } = await planned();
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = 1, close_reason = 'not_planned' WHERE kind = 'child'").run();
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = 1, close_reason = 'not_planned' WHERE kind = 'parent'").run();
    expect((await tree(id)).ready).toBe(false);
    await world.d1.DB.prepare("UPDATE dev_issues SET close_reason = 'completed' WHERE number = ?").bind(kids[0]).run();
    await world.d1.DB.prepare("UPDATE dev_issues SET close_reason = 'completed' WHERE kind = 'parent'").run();
    expect((await tree(id)).ready).toBe(true);
  });

  it("理由の無い閉じた親 (前に閉じた物) は、入れて閉じたものに数える", async () => {
    const { id } = await planned();
    await world.d1.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = 1, close_reason = NULL").run();
    expect((await tree(id)).ready).toBe(true);
  });

  it("ほかのサービスの Issue は入らない", async () => {
    const { id } = await planned();
    await world.d1.DB.prepare("INSERT INTO dev_issues (id, service_id, repo, number, kind, feature, requirement, req_hash, mark_key, state, created_at) VALUES ('other', 'other-service', 'x/y', 777, 'parent', '9-x', NULL, NULL, ?, 'open', 0)").bind("d".repeat(64)).run();
    expect((await tree(id)).parents.map((p) => p.number)).not.toContain(777);
  });

  it("設計書の PR を、設計書のタスクと同じ時に直すタスクから並べる", async () => {
    const { id } = await planned();
    await world.d1.DB.prepare("UPDATE nodes SET pr_number = 41, status = 'review' WHERE source = ?").bind(`design:${id}`).run();
    const [task] = (await world.d1.DB.prepare("SELECT id FROM nodes WHERE source LIKE 'issue:%' LIMIT 1").all<{ id: string }>()).results;
    await world.d1.DB.prepare("INSERT INTO task_docs (node_id, service_id, repo, pr_number, branch, created_at) VALUES (?, ?, 'example/docs', 42, 'b', 0)").bind(task?.id, id).run();
    const got = await tree(id);
    expect(got.docsPrs.map((p) => `${String(p.number)}:${p.kind}`).toSorted((a, b) => a.localeCompare(b))).toEqual(["41:design", "42:together"]);
  });

  it("子が上限より多くても、上限までを返す", async () => {
    const { id, parent } = await planned();
    for (let i = 0; i < 520; i += 1) {
      await world.d1.DB.prepare("INSERT INTO dev_issues (id, service_id, repo, number, parent_number, kind, feature, requirement, req_hash, mark_key, state, created_at) SELECT ?, service_id, repo, ?, ?, 'child', feature, ?, 'h', ?, 'open', 0 FROM dev_issues WHERE kind = 'parent'").bind(`c${String(i)}`, 1000 + i, parent, `r${String(i)}`, i.toString(16).padStart(64, "0")).run();
    }
    const got = await tree(id);
    expect(got.parents.flatMap((p) => p.children)).toHaveLength(500);
  });
});
