// オーナーが画面から作るタスク。題、本文、種類、頼む先と一緒に、直すリポジトリを付けられる (API の nodes)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { recordsOf } from "../../src/gate/work/nodes.ts";
import { stepUp } from "../helpers/approvals.ts";
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

describe("持っているタスクを見送りにする", () => {
  it("止めたタスクを見送りにしてから止めを再開しても、社員はそのタスクを取り直さない", async () => {
    const parentId = await project();
    await clockIn(world, "builder");
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "勤怠の表", taskKind: "build", assignee: "builder" }, 201));
    const book = world.gate.staff.builder.book;
    expect(await book.status(world.clock.now())).toMatchObject({ state: "working", nodeId: task });
    const stop = await api(world, "POST", "/api/v1/guard/stops", { scope: "task", target: task, reason: "見直す" }, 201);
    const [node] = await rows(world.gate.env.DB, "SELECT status, version FROM nodes WHERE id = ?", task);
    await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: node?.["version"], status: "dropped" }, 200);
    // 同じ見送りが 2 度届いても、2 度目は読んだ版が古いので書かない
    await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: node?.["version"], status: "dropped" }, 409);
    await stepUp(world);
    await api(world, "POST", `/api/v1/guard/stops/${z.object({ stopId: z.string() }).parse(stop).stopId}/resume`, {}, 200);
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "dropped" }]);
    expect(await book.status(world.clock.now())).toMatchObject({ nodeId: null });
  });

  it("社員が持ったまま待ちに戻ったタスクを見送りにすると、社員はそのタスクを離れて呼び出しを止める", async () => {
    const parentId = await project();
    await clockIn(world, "builder");
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "勤怠の表", taskKind: "build", assignee: "builder" }, 201));
    const book = world.gate.staff.builder.book;
    expect(await book.status(world.clock.now())).toMatchObject({ state: "working", nodeId: task });
    // 呼び出しの失敗でタスクを todo に戻した後、社員が離れる前の間
    await world.gate.env.DB.prepare("UPDATE nodes SET status = 'todo', version = version + 1 WHERE id = ?").bind(task).run();
    const [node] = await rows(world.gate.env.DB, "SELECT version FROM nodes WHERE id = ?", task);
    await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: node?.["version"], status: "dropped" }, 200);
    expect(await book.status(world.clock.now())).toMatchObject({ nodeId: null });
    expect(await rows(world.gate.env.DB, "SELECT node_id, result FROM work_entries")).toEqual([{ node_id: task, result: "stopped" }]);
  });

  it("頼む先を変えながら見送りにしても、前に持っていた社員がタスクを離れる", async () => {
    const parentId = await project();
    await clockIn(world, "builder");
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "勤怠の表", taskKind: "build", assignee: "builder" }, 201));
    const book = world.gate.staff.builder.book;
    await world.gate.env.DB.prepare("UPDATE nodes SET status = 'todo', version = version + 1 WHERE id = ?").bind(task).run();
    const [node] = await rows(world.gate.env.DB, "SELECT version FROM nodes WHERE id = ?", task);
    await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: node?.["version"], assignee: "president", status: "dropped" }, 200);
    expect(await book.status(world.clock.now())).toMatchObject({ nodeId: null });
  });

  it("社員に離れさせる知らせが届かなくても、見送りは残してエラーログに残す", async () => {
    const parentId = await project();
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "勤怠の表", taskKind: "build" }, 201));
    await world.gate.env.DB.prepare("UPDATE nodes SET assignee = 'builder' WHERE id = ?").bind(task).run();
    const [node] = await rows(world.gate.env.DB, "SELECT version FROM nodes WHERE id = ?", task);
    const staffNs = world.gate.env.STAFF;
    const broken = { idFromName: staffNs.idFromName.bind(staffNs), get: () => ({ dropTask: () => Promise.reject(new Error("届かない")) }) };
    Object.assign(world.gate.env, { STAFF: broken });
    try {
      await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: node?.["version"], status: "dropped" }, 200);
    } finally {
      Object.assign(world.gate.env, { STAFF: staffNs });
    }
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "dropped" }]);
    expect(await rows(recordsOf(world.gate.env, world.clock.now()), "SELECT code FROM error_events")).toEqual([{ code: "staff_drop_failed" }]);
  });

  it("止めた後と再開した後は版が進み、止める前に読んだ版では見送りにできない", async () => {
    const parentId = await project();
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId, scope: "office", title: "勤怠の表", taskKind: "build" }, 201));
    const version = async () => (await rows(world.gate.env.DB, "SELECT version FROM nodes WHERE id = ?", task))[0]?.["version"];
    const before = await version();
    const stop = await api(world, "POST", "/api/v1/guard/stops", { scope: "task", target: task, reason: "見直す" }, 201);
    await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: before, status: "dropped" }, 409);
    const stopped = await version();
    await stepUp(world);
    await api(world, "POST", `/api/v1/guard/stops/${z.object({ stopId: z.string() }).parse(stop).stopId}/resume`, {}, 200);
    await api(world, "PATCH", `/api/v1/nodes/${task}`, { version: stopped, status: "dropped" }, 409);
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "todo" }]);
  });
});
