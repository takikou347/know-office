// オーナーが画面から作るタスク。題、本文、種類、頼む先と一緒に、直すリポジトリを付けられる (API の nodes)
import { describe, expect, it } from "vitest";
import { advance, api, at, clockIn, idOf, purposeAndGoal, REPO, rows, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * 目標の下にプロジェクトを 1 つ置く
 * @returns プロジェクトの ID
 */
async function project(): Promise<string> {
  const { goal } = await purposeAndGoal(world);
  return idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
}

describe("オーナーが画面からタスクを作る", () => {
  it("付けたリポジトリをタスクに残す", async () => {
    const parentId = await project();
    const id = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "訂正を出す", taskKind: "build", repo: REPO }, 201));
    expect(await rows(world.gate.env.DB, "SELECT repo FROM nodes WHERE id = ?", id)).toEqual([{ repo: REPO }]);
  });

  it("owner/name の形でないリポジトリは 422 で断り、何も残さない", async () => {
    const parentId = await project();
    await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "訂正を出す", taskKind: "build", repo: "../know-office" }, 422);
    expect(await rows(world.gate.env.DB, "SELECT id FROM nodes WHERE kind = 'task'")).toEqual([]);
  });

  it("タスクでない物にリポジトリを付けると 422 で断る", async () => {
    const { goal } = await purposeAndGoal(world);
    const failed = await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠", repo: REPO }, 422);
    expect(failed).toMatchObject({ code: "validation_failed" });
  });

  it("時間外に呼び出した社員のタスクを止めると退勤し、次に頼んだタスクでまた呼び出す", async () => {
    const parentId = await project();
    await advance(world, at(21));
    world.headers = await world.gate.signIn();
    const make = async (title: string) => idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title, taskKind: "fix", assignee: "builder" }, 201));
    const first = await make("急ぎの直し");
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "called", nodeId: first });
    await api(world, "POST", "/api/v1/guard/stops", { scope: "task", target: first, reason: "頼み直す" }, 201);
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "off", nodeId: null });
    const second = await make("次の直し");
    expect(await world.gate.staff.builder.book.status(world.clock.now())).toMatchObject({ state: "called", nodeId: second });
  });

  it("終わりの時刻の後の延長の途中でタスクを止めると、チェックポイントを待たずに退勤する", async () => {
    const parentId = await project();
    await clockIn(world, "builder");
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "勤怠の表", taskKind: "build", assignee: "builder" }, 201));
    const book = world.gate.staff.builder.book;
    expect(await book.status(world.clock.now())).toMatchObject({ state: "working", nodeId: task });
    await advance(world, at(17));
    await book.wake(at(17));
    expect(await book.status(at(17))).toMatchObject({ state: "wrapping", nodeId: task });
    await api(world, "POST", "/api/v1/guard/stops", { scope: "task", target: task, reason: "延長の途中で止める" }, 201);
    expect(await book.status(at(17))).toMatchObject({ state: "off", nodeId: null });
  });

  it("止めたタスクをもう一度離れても、次に頼んだタスクを持ったまま何も変えない", async () => {
    const parentId = await project();
    await advance(world, at(21));
    const make = async (title: string) => idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title, taskKind: "fix", assignee: "builder" }, 201));
    const first = await make("急ぎの直し");
    await api(world, "POST", "/api/v1/guard/stops", { scope: "task", target: first, reason: "頼み直す" }, 201);
    const second = await make("次の直し");
    const book = world.gate.staff.builder.book;
    const before = await book.status(world.clock.now());
    expect(before).toMatchObject({ state: "called", nodeId: second });
    // 止めた知らせが 2 度届いた時に、後から取ったタスクを離さない
    await book.drop(first, world.clock.now());
    expect(await book.status(world.clock.now())).toEqual(before);
    expect(await rows(world.gate.env.DB, "SELECT node_id, result FROM work_entries")).toEqual([{ node_id: first, result: "stopped" }]);
  });
});
