// 設計書を同じ時に直す、ワークスペースからの push。サービスのタスクは、設計書のリポジトリの自分のタスクのブランチ (ko/<タスク ID の頭 8 字>-) にだけ push できる (開発の回し方の 3.2、3.6)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DOCS, DOCS2, prototyped, REPO, seedSetting } from "../helpers/docs.ts";
import { push, startTask } from "../helpers/github.ts";
import { observe } from "../../src/gate/guard/observe.ts";
import { useWork } from "../helpers/work.ts";

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
});
