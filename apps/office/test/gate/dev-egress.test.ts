// 開発の代わりのワークスペースが送る出来事を、development の時だけゲートウェイの受け手に回す事を確かめる (ログインと記録の 3.9、社員が考えるの 3.2)
import { describe, expect, it } from "vitest";
import { entryFetch } from "../../src/gate/entry.ts";
import type { Bindings } from "../../src/gate/env.ts";
import { devWorkspaceEgress } from "../../src/gate/work/dev-container.ts";
import { issueTicket } from "../../src/gate/work/ticket.ts";
import { api, clockIn, idOf, purposeAndGoal, rows, staffOf, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/**
 * 開発担当を出勤させ、タスクを 1 つ取らせ、作業トークンを出す
 * @param w テストの物
 * @returns タスク ID と作業トークン
 */
async function builderAtWork(w: WorkWorld): Promise<{ nodeId: string; token: string }> {
  await clockIn(w, "builder");
  const { goal } = await purposeAndGoal(w);
  const project = idOf(await api(w, "POST", "/api/v1/nodes", { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, 201));
  await api(w, "POST", "/api/v1/nodes", { kind: "task", parentId: project, scope: "office", title: "勤怠の表をつなぐ", taskKind: "build", assignee: "builder", priority: 1 }, 201);
  await staffOf(w, "builder").pull(w.clock.now());
  const { nodeId } = await w.gate.staff.builder.book.status(w.clock.now());
  if (nodeId === null) throw new Error("タスクを取れなかった");
  const { token } = await issueTicket(w.gate.env, "builder", nodeId, w.clock.now());
  return { nodeId, token };
}

/**
 * 代わりのワークスペースと同じ形で、開発の入口に出来事を送る
 * @param env バインディング
 * @param path 入口の道
 * @param token 作業トークン
 * @param events 出来事
 * @returns 返事。開発の道でなければ null
 */
function send(env: Bindings, path: string, token: string, events: unknown[]): Promise<Response> | null {
  const request = new Request(`http://localhost:5174${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ events }) });
  return devWorkspaceEgress(request, env, { clock: world.clock, guard: world.gate.deps });
}

describe("開発の代わりのワークスペースの出来事", () => {
  it("社員の道で受けた終わりを、その社員のワークスペースの受け手に回し、タスクを done にする", async () => {
    const { nodeId, token } = await builderAtWork(world);
    const res = await send(world.gate.env, "/__dev/workspace/builder/ws/v1/events", token, [{ kind: "result", nodeId, result: "done" }]);
    expect(res?.status).toBe(204);
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", nodeId)).toEqual([{ status: "done" }]);
  });

  it("ほかの社員の道で送った作業トークンは、発行した先と違うので断る", async () => {
    const { nodeId, token } = await builderAtWork(world);
    const res = await send(world.gate.env, "/__dev/workspace/reviewer/ws/v1/events", token, [{ kind: "result", nodeId, result: "done" }]);
    expect(res?.status).toBe(401);
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", nodeId)).toEqual([{ status: "doing" }]);
  });

  it("作業トークンの要らないハートビートとチェックポイント、知らない社員は 404 で断る", async () => {
    const { token } = await builderAtWork(world);
    for (const path of ["/__dev/workspace/builder/ws/v1/heartbeat", "/__dev/workspace/builder/ws/v1/checkpoints", "/__dev/workspace/nobody/ws/v1/events"]) {
      expect((await send(world.gate.env, path, token, []))?.status).toBe(404);
    }
  });

  it.each([["production"], ["preview"], [undefined]])("development でない所 (%s) では受けず、ゲートウェイに任せる", async (environment) => {
    const { nodeId, token } = await builderAtWork(world);
    const env = { ...world.gate.env, ENVIRONMENT: environment };
    expect(send(env, "/__dev/workspace/builder/ws/v1/events", token, [{ kind: "result", nodeId, result: "done" }])).toBeNull();
  });

  it.each([["production"], ["preview"], [undefined]])("development でない所 (%s) の Worker の入口は、開発の道を断り、ワークスペースの受け手に回さない", async (environment) => {
    const { nodeId, token } = await builderAtWork(world);
    const env = { ...world.gate.env, ENVIRONMENT: environment };
    const request = new Request("http://localhost:5174/__dev/workspace/builder/ws/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [{ kind: "result", nodeId, result: "done" }] }),
    });
    // worker.ts の default export の fetch と同じ関数。worker.ts は DO のクラスも出すので Node では読まない
    const res = await entryFetch(request, env);
    expect([401, 404]).toContain(res.status);
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", nodeId)).toEqual([{ status: "doing" }]);
  });

  it("DEV_FAKES_URL が手元でない時は、投げずに 404 で断る", async () => {
    const { nodeId, token } = await builderAtWork(world);
    const env = { ...world.gate.env, DEV_FAKES_URL: "https://fakes.example.com" };
    const res = await send(env, "/__dev/workspace/builder/ws/v1/events", token, [{ kind: "result", nodeId, result: "done" }]);
    expect(res?.status).toBe(404);
    expect(await rows(world.gate.env.DB, "SELECT status FROM nodes WHERE id = ?", nodeId)).toEqual([{ status: "doing" }]);
  });

  it("開発の道でない要求はゲートウェイに任せる", () => {
    expect(send(world.gate.env, "/api/v1/nodes", "", [])).toBeNull();
  });
});
