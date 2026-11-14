// 手で止める、止めた記録を読む、判定する、再開するルート (自動停止の 3.6、3.7、ルートの一覧の 1.5)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observe } from "../../src/gate/guard/observe.ts";
import { ORIGIN } from "../helpers/gate.ts";
import { addService, denied, jst, MINUTE, NODE, NODE2, rows, startWork, useGuardWorld } from "../helpers/guard.ts";

const w = useGuardWorld();

const Data = z.object({ data: z.unknown() }).loose();

/**
 * ルートを呼ぶ
 * @param method メソッド
 * @param path パス
 * @param headers ログインのヘッダー
 * @param body 本文
 * @returns 返事
 */
function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return w.gate.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * 返事の data を読む
 * @param res 返事
 * @returns data
 */
async function data(res: Response): Promise<unknown> {
  return Data.parse(await res.json()).data;
}

/**
 * ログインする。時計を 9 時半に進めてから
 * @returns ログインのヘッダー
 */
async function signIn(): Promise<Record<string, string>> {
  w.clock.advance(jst(9, 30) - w.clock.now());
  return w.gate.signIn();
}

/** パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる */
async function stepUp(): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

describe("通知と手で止めるボタン", () => {
  it("手で止める", async () => {
    await startWork(w, "builder");
    const headers = await signIn();
    const preview = await call("POST", "/api/v1/guard/stop-previews", { ...headers }, { scope: "staff", target: "builder" });
    expect(preview.status).toBe(200);
    expect(await data(preview)).toEqual({ staff: ["builder"], nodes: 1 });
    expect(await data(await call("POST", "/api/v1/guard/stop-previews", headers, { scope: "office", target: "office" }))).toEqual({ staff: ["president", "builder", "reviewer"], nodes: 1 });
    // 確認の画面は数えるだけで、何も止めない
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("working");
    const res = await call("POST", "/api/v1/guard/stops", headers, { scope: "staff", target: "builder", reason: "様子がおかしい" });
    expect(res.status).toBe(201);
    const { stopId } = z.object({ stopId: z.string() }).parse(await data(res));
    expect(res.headers.get("Location")).toBe(`/api/v1/guard/stops/${stopId}`);
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("stopped");
    expect(await rows(w, "SELECT scope, target, signal, by FROM stops")).toEqual([{ scope: "staff", target: "builder", signal: "manual", by: "owner" }]);
    expect(w.gate.audits.at(-1)).toMatchObject({ action: "guard.stop", actor: "owner", target: stopId });
    // 止まっている物をもう一度止めない。無い相手は 404
    expect((await call("POST", "/api/v1/guard/stops", headers, { scope: "staff", target: "builder", reason: "もう一度" })).status).toBe(409);
    expect((await call("POST", "/api/v1/guard/stop-previews", headers, { scope: "task", target: NODE2 })).status).toBe(404);
    expect((await call("POST", "/api/v1/guard/stops", headers, { scope: "service", target: "nothing", reason: "x" })).status).toBe(404);
    const state = await data(await call("GET", "/api/v1/guard/state", headers));
    expect(state).toEqual({ stopped: [{ scope: "staff", target: "builder", stopId, since: new Date(w.clock.now()).toISOString() }] });
  });
});

describe("再開", () => {
  it("レビュー担当が再開する", async () => {
    await startWork(w, "builder");
    w.gate.deps.answer = { resume: true, reason: "読み違いで、外には出ていない" };
    await observe(w.gate.env, denied(), jst(10), w.gate.deps);
    expect(await rows(w, "SELECT kind, by, reason FROM stop_updates")).toEqual([{ kind: "resumed", by: "reviewer", reason: "読み違いで、外には出ていない" }]);
    expect(await rows(w, `SELECT status, assignee FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "todo", assignee: "builder" }]);
    // タスクの数は 0 に戻るので、同じ操作をもう一度数え、社員ごとの 60 分の数は残るので社員が止まる
    w.gate.deps.answer = null;
    await w.gate.staff.builder.book.take({ nodeId: NODE, title: "続き", scope: "office" }, null, jst(10, 1));
    expect(await observe(w.gate.env, denied(), jst(10, 2), w.gate.deps)).toMatchObject({ action: "stop", scope: "staff" });
  });

  it("問題があると返ればタスクは止めたまま", async () => {
    await startWork(w, "builder");
    w.gate.deps.answer = { resume: false, reason: "鍵を探していた" };
    await observe(w.gate.env, denied(), jst(10), w.gate.deps);
    expect(await rows(w, "SELECT kind, by, verdict FROM stop_updates")).toEqual([{ kind: "verdict", by: "reviewer", verdict: "correct" }]);
    expect(await rows(w, `SELECT status FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "stopped" }]);
  });

  it("全体の再開", async () => {
    await startWork(w, "builder");
    await observe(w.gate.env, { type: "chain_broken", year: 2030 }, jst(9, 10), w.gate.deps);
    const headers = await signIn();
    const [stop] = await rows(w, "SELECT id FROM stops");
    const path = `/api/v1/guard/stops/${String(stop?.["id"])}/resume`;
    const without = await call("POST", path, headers);
    expect(without.status).toBe(401);
    expect(await without.json()).toMatchObject({ code: "step_up_required" });
    await stepUp();
    // 外の鍵を入れ直すまでは再開しない
    expect((await call("POST", path, headers)).status).toBe(409);
    await w.gate.office.releaseKeys();
    const res = await call("POST", path, headers);
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ resumedAt: new Date(w.clock.now()).toISOString() });
    expect((await w.gate.staff.builder.book.status(w.clock.now())).state).toBe("working");
    expect((await call("POST", path, headers)).status).toBe(409);
    expect(w.gate.audits.at(-1)).toMatchObject({ action: "guard.resume" });
  });

  it("同時に再開を押しても、再開の記録は 1 行", async () => {
    await startWork(w, "builder");
    await observe(w.gate.env, denied(), jst(9, 5), w.gate.deps);
    const headers = await signIn();
    const [stop] = await rows(w, "SELECT id FROM stops");
    const path = `/api/v1/guard/stops/${String(stop?.["id"])}/resume`;
    const statuses = await Promise.all([call("POST", path, headers), call("POST", path, headers)]);
    expect(statuses.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await rows(w, "SELECT kind FROM stop_updates")).toEqual([{ kind: "resumed" }]);
  });

  it("サービスの再開にもパスキーが要り、タスクの再開には要らない", async () => {
    await addService(w, "shop", "library");
    await startWork(w, "builder");
    await observe(w.gate.env, { type: "deploy_result", serviceId: "shop", kind: "library", version: "1.0.0", buildPassed: false }, jst(9, 5), w.gate.deps);
    await observe(w.gate.env, denied(), jst(9, 6), w.gate.deps);
    const headers = await signIn();
    const ids = await rows(w, "SELECT id, scope FROM stops ORDER BY id");
    const service = ids.find((r) => r["scope"] === "service");
    const task = ids.find((r) => r["scope"] === "task");
    expect((await call("POST", `/api/v1/guard/stops/${String(service?.["id"])}/resume`, headers)).status).toBe(401);
    expect((await call("POST", `/api/v1/guard/stops/${String(task?.["id"])}/resume`, headers)).status).toBe(200);
    expect(await rows(w, `SELECT status FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "todo" }]);
  });
});

describe("止めた記録", () => {
  it("一覧、1 件、判定", async () => {
    await startWork(w, "builder");
    await observe(w.gate.env, { type: "tool_call", staffId: "builder" }, jst(9, 1), w.gate.deps);
    await observe(w.gate.env, denied(), jst(9, 2), w.gate.deps);
    const headers = await signIn();
    const list = await call("GET", "/api/v1/guard/stops?kind=stop&scope=task", headers);
    expect(list.status).toBe(200);
    const [row] = z.array(z.object({ id: z.string() }).loose()).parse(await data(list));
    expect(row).toMatchObject({ kind: "stop", scope: "task", target: NODE, signal: "rule_denied", measured: 1, threshold: 1, by: "system", resumedAt: null, verdict: null });
    const id = String(row?.id);
    const verdict = await call("POST", `/api/v1/guard/stops/${id}/verdict`, { ...headers, Origin: ORIGIN }, { verdict: "false", reason: "読んでよい道だった" });
    expect(verdict.status).toBe(201);
    expect(await data(verdict)).toMatchObject({ stopId: id, kind: "verdict", by: "owner" });
    const detail = await data(await call("GET", `/api/v1/guard/stops/${id}`, headers));
    expect(detail).toMatchObject({ id, verdict: "false", rulesVersion: 0, model: "claude-opus-5-5", externalSources: [] });
    expect(z.object({ recentOps: z.array(z.object({ type: z.string() }).loose()) }).loose().parse(detail).recentOps.map((op) => op.type)).toEqual(["tool_call", "rule_denied"]);
    expect((await call("GET", "/api/v1/guard/stops/0190f4a8-0000-7000-8000-00000000ffff", headers)).status).toBe(404);
    // 社員にひもづかない止めた記録はモデルを持たない
    const office = await call("POST", "/api/v1/guard/stops", headers, { scope: "office", target: "office", reason: "確かめ" });
    const officeId = z.object({ stopId: z.string() }).parse(await data(office)).stopId;
    w.clock.advance(MINUTE);
    const fresh = await w.gate.signIn();
    expect(await data(await call("GET", `/api/v1/guard/stops/${officeId}`, fresh))).toMatchObject({ model: null });
  });
});
