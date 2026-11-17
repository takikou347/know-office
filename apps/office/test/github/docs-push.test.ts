// 設計書を同じ時に直す、ワークスペースからの push。サービスのタスクは、設計書のリポジトリの自分のタスクのブランチ (ko/<タスク ID の頭 8 字>-) にだけ push できる (開発の回し方の 3.2、3.6)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DOCS, DOCS2, prototyped, REPO, seedSetting } from "../helpers/docs.ts";
import { push, startTask } from "../helpers/github.ts";
import { observe } from "../../src/gate/guard/observe.ts";
import { rows, useWork } from "../helpers/work.ts";

const world = useWork({ github: true });
const Problem = z.object({ code: z.string() }).loose();

/**
 * サービスのタスクを開発担当に取らせる。scope はサービス ID、repo はサービスのリポジトリ
 * @returns 作業トークンとタスク ID
 */
async function serviceTask() {
  const service = await prototyped(world);
  const work = await startTask(world, REPO);
  await world.d1.DB.prepare("UPDATE nodes SET scope = ? WHERE id = ?").bind(service, work.nodeId).run();
  return work;
}

/**
 * push を断った答えの状態と種類を読む
 * @param res 受け手の返事
 * @returns 状態と種類
 */
async function denied(res: Response) {
  return { status: res.status, code: Problem.parse(await res.json()).code };
}

describe("設計書を同じ時に直す", () => {
  it("設計書のリポジトリの自分のブランチに push できる", async () => {
    const work = await serviceTask();
    const res = await push(world, work, DOCS, [{ ref: `refs/heads/ko/${work.nodeId.slice(0, 8)}-spec` }]);
    expect(res.status).toBe(200);
  });

  it("ほかのタスクのブランチは断り、記録が残る", async () => {
    const work = await serviceTask();
    // 数えた回数は、同じ種類の出来事をもう 1 回数えた時の measured で見る (断りで 1 回、見る呼びで 2 回目)
    const count = async () => (await observe(world.gate.env, { type: "rule_denied", staffId: "builder", nodeId: work.nodeId, operation: "office.tool", target: "probe" }, world.clock.now(), world.gate.deps)).measured;
    const res = await push(world, work, DOCS, [{ ref: "refs/heads/ko/00000000-spec" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    // 断りが 1 回数えられている (数える呼びで 2 回目)
    expect(await count()).toBe(2);
  });

  it("設計書のリポジトリでないリポジトリは断る", async () => {
    const work = await serviceTask();
    await seedSetting(world, "devloop.docs_repo", { repo: DOCS2 }, 2);
    const res = await push(world, work, DOCS, [{ ref: `refs/heads/ko/${work.nodeId.slice(0, 8)}-spec` }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
  });

  it("サービスのタスクでないタスクは、設計書のリポジトリに push できない", async () => {
    const service = await prototyped(world);
    // 範囲が office のタスク
    const office = await startTask(world, REPO);
    await world.d1.DB.prepare("UPDATE nodes SET scope = 'office' WHERE id = ?").bind(office.nodeId).run();
    expect(await denied(await push(world, office, DOCS, [{ ref: `refs/heads/ko/${office.nodeId.slice(0, 8)}-spec` }]))).toEqual({ status: 403, code: "rule_denied" });
    // サービスのタスクでも、リポジトリがそのサービスのでないもの
    const other = await startTask(world, REPO);
    await world.d1.DB.prepare("UPDATE nodes SET scope = ?, repo = 'example/other' WHERE id = ?").bind(service, other.nodeId).run();
    expect(await denied(await push(world, other, DOCS, [{ ref: `refs/heads/ko/${other.nodeId.slice(0, 8)}-spec` }]))).toEqual({ status: 403, code: "rule_denied" });
  });

  it.each([
    ["自分のブランチが先", (own: string) => [own, "refs/heads/ko/00000000-spec"]],
    ["ほかの ref が先", (own: string) => ["refs/heads/feature", own]],
  ])("自分のブランチとほかの ref が混ざる push は、全部断る (%s)", async (_name, refs) => {
    const work = await serviceTask();
    const own = `refs/heads/ko/${work.nodeId.slice(0, 8)}-spec`;
    expect(await denied(await push(world, work, DOCS, refs(own).map((ref) => ({ ref }))))).toEqual({ status: 403, code: "rule_denied" });
  });

  it.each([
    ["main", "refs/heads/main", undefined],
    ["ref を消す", "-spec", "0".repeat(40)],
    ["崩れた ref (..)", "-spec..x", undefined],
    ["崩れた ref (.lock)", "-spec.lock", undefined],
    ["タグ", "refs/tags/ko-spec", undefined],
  ])("自分の前置きの下でも、%s は断る", async (_name, suffix, to) => {
    const work = await serviceTask();
    const ref = suffix.startsWith("refs/") ? suffix : `refs/heads/ko/${work.nodeId.slice(0, 8)}${suffix}`;
    expect(await denied(await push(world, work, DOCS, [{ ref, ...(to === undefined ? {} : { to }) }]))).toEqual({ status: 403, code: "rule_denied" });
  });

  it("頭 8 字が同じ別のタスクの設計書のブランチには、行が無くても push できず、記録が残る", async () => {
    const work = await serviceTask();
    const prefix = work.nodeId.slice(0, 8);
    // 頭 8 字が同じ別のタスクが、設計書の PR の行を持っている
    const other = `${prefix}-0000-7000-8000-000000000000`;
    const [row] = await rows(world.d1.DB, "SELECT * FROM nodes WHERE id = ?", work.nodeId);
    const copy = { ...row, id: other, source: `other:${other}`, issue_number: null, pr_number: null, branch: null };
    const names = Object.keys(copy);
    await world.d1.DB.prepare(`INSERT INTO nodes (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).bind(...Object.values(copy)).run();
    await world.d1.DB.prepare("INSERT INTO task_docs (node_id, service_id, repo, pr_number, branch, created_at) VALUES (?, ?, ?, 90, ?, 1)").bind(other, String(row?.["scope"]), DOCS, `ko/${prefix}-spec`).run();
    const count = async () => (await observe(world.gate.env, { type: "rule_denied", staffId: "builder", nodeId: work.nodeId, operation: "office.tool", target: "probe" }, world.clock.now(), world.gate.deps)).measured;
    expect(await denied(await push(world, work, DOCS, [{ ref: `refs/heads/ko/${prefix}-spec` }]))).toEqual({ status: 403, code: "rule_denied" });
    expect(await count()).toBe(2);
  });

  it("設計書の PR の行があれば、その行のブランチだけに push でき、行が無い最初の push だけ前置きで通す", async () => {
    const work = await serviceTask();
    const prefix = `refs/heads/ko/${work.nodeId.slice(0, 8)}`;
    // 行が無い最初の push は、前置きの下ならどれでも通す
    expect((await push(world, work, DOCS, [{ ref: `${prefix}-first` }])).status).toBe(200);
    // 行ができたら、行のブランチだけ
    await world.d1.DB.prepare("INSERT INTO task_docs (node_id, service_id, repo, pr_number, branch, created_at) VALUES (?1, (SELECT scope FROM nodes WHERE id = ?1), ?2, NULL, ?3, 1)").bind(work.nodeId, DOCS, `ko/${work.nodeId.slice(0, 8)}-spec`).run();
    expect((await push(world, work, DOCS, [{ ref: `${prefix}-spec` }])).status).toBe(200);
    expect(await denied(await push(world, work, DOCS, [{ ref: `${prefix}-other` }]))).toEqual({ status: 403, code: "rule_denied" });
  });
});
