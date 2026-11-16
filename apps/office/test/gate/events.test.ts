// ワークスペースが送る出来事 (POST /ws/v1/events) が、発言、ツールの結果、チェックポイント、エラー、終わりとしてゲートウェイに届く事を確かめる (社員が考えるの 3.2、3.7)
import type { StaffId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { type Caller, routeEgress } from "../../src/gate/egress.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { api, clockIn, idOf, purposeAndGoal, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/** 1 つのテストの社員、タスク、作業トークン */
type Work = { staffId: StaffId; nodeId: string; token: string };

/**
 * 開発担当を出勤させ、タスクを 2 つ置いて 1 つ取らせ、作業トークンを出す
 * @param w テストの物
 * @returns 社員、タスク、作業トークン、2 つ目のタスク
 */
async function builderAtWork(w: WorkWorld): Promise<Work & { next: string }> {
  await clockIn(w, "builder");
  const { goal } = await purposeAndGoal(w);
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
  const make = async (title: string, priority: number) =>
    idOf(await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title, taskKind: "build", assignee: "builder", priority }, 201));
  await make("勤怠の表をつなぐ", 1);
  const next = await make("勤怠の訂正を出す", 2);
  await staffOf(w, "builder").pull(w.clock.now());
  const { nodeId } = await w.gate.staff.builder.book.status(w.clock.now());
  if (nodeId === null) throw new Error("タスクを取れなかった");
  const { token } = await issueTicket(w.gate.env, "builder", nodeId, w.clock.now());
  return { staffId: "builder", nodeId, token, next };
}

/**
 * ワークスペースと同じ形で出来事を送る
 * @param w テストの物
 * @param work 社員と作業トークン
 * @param events 出来事
 * @param token 付ける作業トークン。省くと work の物
 * @returns 返事
 */
function send(w: WorkWorld, work: Work, events: unknown[], token = work.token): Promise<Response> {
  const caller: Caller = { staffId: work.staffId, workspaceId: workspaceIdOf(w.gate.env, work.staffId) };
  const auth: Record<string, string> = token === "" ? {} : { authorization: `Bearer ${token}` };
  const request = new Request("http://gate.internal/ws/v1/events", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ events }) });
  return routeEgress(request, w.gate.env, caller, { clock: w.clock, guard: w.gate.deps });
}

/**
 * タスクの状態を読む
 * @param w テストの物
 * @param nodeId タスク ID
 * @returns 状態
 */
async function statusOf(w: WorkWorld, nodeId: string): Promise<unknown> {
  return (await rows(w.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", nodeId))[0]?.["status"];
}

describe("働いた事がゲートウェイに届く", () => {
  it("社員の発言を会話に足し、2,000 字を超える本文は R2 に置く", async () => {
    const work = await builderAtWork(world);
    const long = "長".repeat(2500);
    expect((await send(world, work, [{ kind: "message", body: "ログインを直した" }, { kind: "message", body: long }])).status).toBe(204);
    const said = await rows(world.d1.REC_2026, "SELECT node_id, sender, body, body_key FROM messages ORDER BY length(body)");
    expect(said.map((r) => [r["node_id"], r["sender"], String(r["body"]).length, r["body_key"] === null])).toEqual([
      [work.nodeId, "staff", 8, true],
      [work.nodeId, "staff", 2000, false],
    ]);
    const key = String(said[1]?.["body_key"]);
    expect(key).toMatch(/^messages\/builder\/[0-9a-f-]{36}\.txt$/);
    expect(await (await world.d1.FILES.get(key))?.text()).toBe(long);
    // 開いている画面にも配り、長い本文は頭だけにして印を付ける
    const live = world.gate.live.published.filter((e) => JSON.stringify(e).startsWith('{"type":"message"'));
    expect(live).toMatchObject([
      { message: { staffId: "builder", sender: "staff", body: "ログインを直した", truncated: false } },
      { message: { staffId: "builder", sender: "staff", truncated: true } },
    ]);
  });

  it("エラーをエラーログに残し、鍵の形を伏せ、決めた名前のほかは 422 で断る", async () => {
    const work = await builderAtWork(world);
    expect((await send(world, work, [{ kind: "error", name: "sdk_failed", message: "落ちた sk-ant-api03-abcdefghijklmnop" }])).status).toBe(204);
    const logged = await rows(world.d1.REC_2026, "SELECT source, code, message FROM error_events WHERE source = 'workspace'");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ source: "workspace", code: "sdk_failed" });
    expect(String(logged[0]?.["message"])).not.toContain("abcdefghijklmnop");
    expect((await send(world, work, [{ kind: "error", name: "my_note", message: "好きな文" }])).status).toBe(422);
    expect((await send(world, work, [{ kind: "error", name: "sdk_failed", message: "x".repeat(201) }])).status).toBe(422);
  });

  it("鍵の失敗は、3 人が続けて送っても通知を 1 件だけ出す", async () => {
    await clockIn(world, "president", "reviewer");
    const work = await builderAtWork(world);
    for (const staffId of ["builder", "president", "reviewer"] as const) {
      const { token } = staffId === "builder" ? work : await issueTicket(world.gate.env, staffId, work.nodeId, world.clock.now());
      expect((await send(world, { staffId, nodeId: work.nodeId, token }, [{ kind: "error", name: "sdk_auth_failed", message: "Claude API が 401 で断った" }])).status).toBe(204);
    }
    const notices = await rows(world.gate.env.DB, "SELECT id, kind FROM notices WHERE kind = 'sdk_auth_failed'");
    expect(notices.map((n) => n["kind"])).toEqual(["sdk_auth_failed"]);
    // 足した 1 件だけを画面に配る
    expect(world.gate.live.published.filter((e) => JSON.stringify(e).includes('"notice"'))).toEqual([{ type: "notice", notice: { id: notices[0]?.["id"] } }]);
  });

  it("終わりでタスクを done にし、作業トークンを失効させ、次のタスクを取る", async () => {
    const work = await builderAtWork(world);
    expect((await send(world, work, [{ kind: "result", nodeId: work.nodeId, result: "done" }])).status).toBe(204);
    expect(await statusOf(world, work.nodeId)).toBe("done");
    expect(await rows(world.d1.REC_2026, "SELECT kind FROM node_events WHERE node_id = ? AND kind = 'finished'", work.nodeId)).toHaveLength(1);
    expect((await world.gate.staff.builder.book.status(world.clock.now())).nodeId).toBe(work.next);
    // 終えたタスクの作業トークンは使えない
    expect((await send(world, work, [{ kind: "message", body: "まだいる" }])).status).toBe(401);
  });

  it("同時の 2 回の終わりで、終えた出来事は 1 件だけ残る", async () => {
    const work = await builderAtWork(world);
    const done = [{ kind: "result", nodeId: work.nodeId, result: "done" }];
    const answers = await Promise.all([send(world, work, done), send(world, work, done)]);
    // 後の方は、先の方が書いた後なら 409、次のタスクへ移った後なら今のタスクでない終わりとして 204 になる
    for (const answer of answers) expect([204, 409]).toContain(answer.status);
    expect(await rows(world.d1.REC_2026, "SELECT kind FROM node_events WHERE node_id = ? AND kind = 'finished'", work.nodeId)).toHaveLength(1);
  });

  it("今のタスクでない終わりは何もせず、持っているタスクの呼び出しを始める", async () => {
    const work = await builderAtWork(world);
    // pr_open などで社員が先に離れ、次のタスクを持っている形にする
    await staffOf(world, "builder").finish("done", world.clock.now());
    await staffOf(world, "builder").pull(world.clock.now());
    expect((await send(world, work, [{ kind: "result", nodeId: work.nodeId, result: "done" }])).status).toBe(204);
    expect(await statusOf(world, work.nodeId)).toBe("doing");
    expect(world.gate.workspaces.builder.runs).toEqual([expect.objectContaining({ nodeId: work.next })]);
  });

  it("handed_back でタスクを todo に戻し、すぐには取り直さない", async () => {
    const work = await builderAtWork(world);
    expect((await send(world, work, [{ kind: "error", name: "sdk_failed", message: "落ちた" }, { kind: "result", nodeId: work.nodeId, result: "handed_back" }])).status).toBe(204);
    expect(await statusOf(world, work.nodeId)).toBe("todo");
    expect((await world.gate.staff.builder.book.status(world.clock.now())).nodeId).toBeNull();
  });

  it("今のタスクと違うチェックポイントは 409 で断り、出来事に残さない", async () => {
    const work = await builderAtWork(world);
    const res = await send(world, work, [{ kind: "checkpoint", nodeId: work.next, checkpoint: "commit" }]);
    expect(res.status).toBe(409);
    expect((await send(world, work, [{ kind: "checkpoint", nodeId: work.nodeId, checkpoint: "test_pass" }])).status).toBe(204);
    expect(await rows(world.d1.REC_2026, "SELECT node_id FROM node_events WHERE kind = 'checkpoint'")).toEqual([{ node_id: work.nodeId }]);
  });

  it("ツールの結果は会話にも記録にも書かず受ける", async () => {
    const work = await builderAtWork(world);
    expect((await send(world, work, [{ kind: "tool_result", toolName: "Bash", command: "pnpm test", exitCode: 1, failedChecks: ["test"] }])).status).toBe(204);
    expect(await rows(world.d1.REC_2026, "SELECT id FROM messages WHERE node_id = ?", work.nodeId)).toEqual([]);
  });

  it("1 時間を過ぎた run の終わりも届く", async () => {
    const work = await builderAtWork(world);
    const caller: Caller = { staffId: "builder", workspaceId: workspaceIdOf(world.gate.env, "builder") };
    // ワークスペースは 30 秒ごとにハートビートを送る。テストは 1 分ごとに送って 65 分進める
    for (let minute = 1; minute <= 65; minute += 1) {
      world.clock.advance(60_000);
      const beat = new Request("http://gate.internal/ws/v1/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: new Date(world.clock.now()).toISOString() }) });
      expect((await routeEgress(beat, world.gate.env, caller, { clock: world.clock, guard: world.gate.deps })).status).toBe(204);
    }
    // 残りが 10 分を切った所でハートビートの道で差し替え、ワークスペースに渡した
    const renewed = world.gate.workspaces.builder.tickets;
    expect(renewed).toHaveLength(1);
    expect((await send(world, work, [{ kind: "message", body: "前の作業トークン" }])).status).toBe(401);
    expect((await send(world, work, [{ kind: "result", nodeId: work.nodeId, result: "done" }], renewed[0])).status).toBe(204);
    expect(await statusOf(world, work.nodeId)).toBe("done");
  });

  it("51 件と空の並びは 422、作業トークンが無ければ 401 で断る", async () => {
    const work = await builderAtWork(world);
    const many = Array.from({ length: 51 }, () => ({ kind: "message", body: "x" }));
    expect((await send(world, work, many)).status).toBe(422);
    expect((await send(world, work, [])).status).toBe(422);
    expect((await send(world, work, [{ kind: "message", body: "x" }], "")).status).toBe(401);
    expect(await rows(world.d1.REC_2026, "SELECT id FROM messages WHERE node_id = ?", work.nodeId)).toEqual([]);
  });
});
