// push はタスクを取った時に決めたブランチ (ko/<タスク ID>) だけを通す。ほかの名前、ブランチの無いタスク、レビューのタスクの push は断り、ルールの外の操作として数える (タスクとレビューの 3.3)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observe } from "../../src/gate/guard/observe.ts";
import { connect, push, startTask } from "../helpers/github.ts";
import { useWork } from "../helpers/work.ts";

const world = useWork();

const UI = "example/knowidea-ui";
const Problem = z.object({ code: z.string() }).loose();

/**
 * 代わりの GitHub の git の受け口に届いた要求
 * @returns 「メソッド パス」
 */
function gitRequests(): string[] {
  return world.gate.github.requests.filter((r) => r.route.includes(".git/")).map((r) => r.route);
}

describe("GitHub のルール", () => {
  it("タスクのブランチでない名前への push は断る (同じ頭 8 字の別のタスクのブランチを含む)", async () => {
    await connect(world);
    const id = crypto.randomUUID();
    // 頭 8 字が同じでも、ID の違う別のタスクのブランチは自分のブランチでない
    const twin = `${id.slice(0, 8)}${crypto.randomUUID().slice(8)}`;
    const answers: Record<string, unknown> = {};
    let last = "";
    // 自分のブランチは通す
    const own = await startTask(world, UI, "builder", { branch: `ko/${id}` });
    expect((await push(world, own, UI, [{ ref: `refs/heads/ko/${id}` }])).status).toBe(200);
    // 断るとタスクが止まって作業トークンが失効し、2 回で社員も止まるので、ref ごとに別のタスクで 2 つだけ送る
    for (const ref of [`refs/heads/ko/${twin}`, `refs/heads/ko/${id.slice(0, 8)}-attendance`]) {
      const work = await startTask(world, UI, "builder", { branch: `ko/${id}` });
      const res = await push(world, work, UI, [{ ref }]);
      answers[ref] = { status: res.status, code: Problem.parse(await res.json()).code };
      last = work.nodeId;
    }
    expect(Object.values(answers)).toEqual([0, 1].map(() => ({ status: 403, code: "rule_denied" })));
    expect(gitRequests()).toEqual([`POST /${UI}.git/git-receive-pack`]);
    // 断った push はルールの外の操作として数える。数えた回数は、同じ種類をもう 1 回数えた時の measured で見る (社員ごとに数え、断りで 2 回、見る呼びで 3 回目)
    const measured = (await observe(world.gate.env, { type: "rule_denied", staffId: "builder", nodeId: last, operation: "office.tool", target: "probe" }, world.clock.now(), world.gate.deps)).measured;
    expect(measured).toBe(3);
  });

  it("branch の無いタスクの push は断る", async () => {
    await connect(world);
    const work = await startTask(world, UI, "builder", { branch: null });
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(gitRequests()).toEqual([]);
  });
});

describe("タスクのブランチへの push", () => {
  it("自分のブランチとほかのブランチが混ざった push は全部断る", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }, { ref: "refs/heads/ko/b-2.x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(gitRequests()).toEqual([]);
  });

  it("大文字と小文字だけが違うブランチへの push は断る", async () => {
    await connect(world);
    const work = await startTask(world, UI, "builder", { branch: "ko/abc" });
    const res = await push(world, work, UI, [{ ref: "refs/heads/KO/abc" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(gitRequests()).toEqual([]);
  });

  it("レビューのタスクの push は断る", async () => {
    await connect(world);
    const work = await startTask(world, UI, "reviewer", { taskKind: "review" });
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(gitRequests()).toEqual([]);
  });
});
