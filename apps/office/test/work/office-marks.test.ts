// オフィスの出来事の印。タスクを渡した、レビューを頼んだ、承認した、差し戻した時に、誰から誰へと題を配信に渡す (画面の全体の 3.2、社員が考えるの 3.8)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appendNodeEvent } from "../../src/gate/work/nodes.ts";
import { api, at, rows, advance, clockIn, idOf, purposeAndGoal, REPO, staffOf, tool, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

const Work = z.object({ type: z.literal("work"), work: z.object({ nodeId: z.string() }).loose() }).strict();

/**
 * 配った印のうち、オフィスの出来事の印だけを返す
 * @param w テストの世界
 * @returns 出来事の印の中身
 */
function workMarks(w: WorkWorld): unknown[] {
  return w.gate.live.published.filter((e) => Work.safeParse(e).success).map((e) => Work.parse(e).work);
}

/**
 * 社長が開発担当に頼んだタスクを、開発担当がプルリクエストに出すまで進める
 * @returns タスクの ID
 */
async function openReview(): Promise<string> {
  const { goal } = await purposeAndGoal(world);
  await clockIn(world, "president", "builder", "reviewer");
  await staffOf(world, "builder").pull(world.clock.now());
  await staffOf(world, "president").pull(world.clock.now());
  const project = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "project", parentId: goal, title: "勤怠" })).content)).id;
  const task = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "task", parentId: project, title: "勤怠の表をつなぐ", taskKind: "build", repo: REPO, assignee: "builder" })).content)).id;
  await staffOf(world, "builder").pull(world.clock.now());
  world.gate.live.published.length = 0;
  await tool(world, "builder", "pr_open", { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" });
  await staffOf(world, "reviewer").pull(world.clock.now());
  return task;
}

describe("オフィスの出来事の印", () => {
  it("社長がタスクを作って頼むと、社長から担当への渡す印を配る", async () => {
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "president");
    await staffOf(world, "president").pull(world.clock.now());
    const project = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "project", parentId: goal, title: "勤怠" })).content)).id;
    world.gate.live.published.length = 0;
    const task = z.object({ id: z.string() }).parse(JSON.parse((await tool(world, "president", "node_create", { kind: "task", parentId: project, title: "勤怠の表", taskKind: "build", assignee: "builder" })).content)).id;
    expect(workMarks(world)).toEqual([{ nodeId: task, title: "勤怠の表", action: "assign", from: "president", to: "builder" }]);
  });

  it("オーナーが画面で頼む先を付けると、オーナーから担当への渡す印を配り、頼む先を付けない直しでは配らない", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    const made = z.object({ id: z.string(), version: z.number() }).loose().parse(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "勤怠の表", taskKind: "build", priority: 1 }, 201));
    const renamed = z.object({ version: z.number() }).loose().parse(await api(world, "PATCH", `/api/v1/nodes/${made.id}`, { version: made.version, title: "勤怠の表を足す" }));
    expect(workMarks(world)).toEqual([]);
    await api(world, "PATCH", `/api/v1/nodes/${made.id}`, { version: renamed.version, assignee: "builder" });
    expect(workMarks(world)).toEqual([{ nodeId: made.id, title: "勤怠の表を足す", action: "assign", from: "owner", to: "builder" }]);
  });

  it("プルリクエストを出すと、レビュー担当に頼む印を配り、自動で作るレビューのタスクは渡す印にしない", async () => {
    const task = await openReview();
    expect(workMarks(world)).toEqual([{ nodeId: task, title: "勤怠の表をつなぐ", action: "review-request", from: "builder", to: "reviewer" }]);
  });

  it("レビュー担当が差し戻すと、レビュー担当から作った社員への差し戻しの印を配る", async () => {
    const task = await openReview();
    await advance(world, at(9, 40));
    world.gate.live.published.length = 0;
    expect(await tool(world, "reviewer", "review_submit", { verdict: "reject", summary: "空の日の表のテストが無い", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    // レビュー担当が続けて作るタスクの渡す印は、ここでは見ない
    expect(workMarks(world).filter((m) => z.object({ nodeId: z.literal(task) }).loose().safeParse(m).success)).toEqual([{ nodeId: task, title: "勤怠の表をつなぐ", action: "send-back", from: "reviewer", to: "builder" }]);
  });

  it("レビュー担当が承認すると、レビュー担当から作った社員への承認の印を配る", async () => {
    const task = await openReview();
    await advance(world, at(9, 40));
    world.gate.live.published.length = 0;
    expect(await tool(world, "reviewer", "review_submit", { verdict: "approve", summary: "表のテストがある", headSha: "b".repeat(40) })).toMatchObject({ isError: false });
    expect(workMarks(world)).toContainEqual({ nodeId: task, title: "勤怠の表をつなぐ", action: "approve", from: "reviewer", to: "builder" });
  });

  it("タスクを読めない時も出来事は書け、配れなかった事をエラーログに残す", async () => {
    const missing = "019a7b00-0000-7000-8000-0000000000ff";
    await appendNodeEvent(world.gate.env, { nodeId: missing, staffId: null, kind: "owner_approved", detail: { by: "owner" } }, { by: "owner", now: world.clock.now() });
    expect(workMarks(world)).toEqual([]);
    expect(world.gate.live.published).toContainEqual({ type: "node", node: { id: missing } });
    expect(await rows(world.d1.REC_2026, "SELECT code FROM error_events WHERE code = 'live_publish_failed'")).toHaveLength(1);
  });

  it("同じ鍵の出来事を 2 度書いても、仕事の出来事は 1 度だけ配る", async () => {
    const { goal } = await purposeAndGoal(world);
    const project = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
    const task = idOf(await api(world, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "勤怠の表", taskKind: "build", assignee: "builder", priority: 1 }, 201));
    world.gate.live.published.length = 0;
    const event = { nodeId: task, staffId: null, kind: "owner_approved", detail: { by: "owner" }, key: `owner_approved:${task}` };
    const actor = { by: "owner", now: world.clock.now() };
    await appendNodeEvent(world.gate.env, event, actor);
    await appendNodeEvent(world.gate.env, event, actor);
    expect(workMarks(world)).toEqual([{ nodeId: task, title: "勤怠の表", action: "approve", from: "owner", to: "builder" }]);
  });
});
