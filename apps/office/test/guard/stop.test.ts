// 出来事を受けて止める動きを、社員の動きを並べたモックの出来事で確かめる (自動停止の 3.4、3.5、4 章)
import { AppError, DEFAULT_THRESHOLDS } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyStop, type StopInput } from "../../src/gate/guard/actions.ts";
import { checkOverruns, observe, verifyWorkToken } from "../../src/gate/guard/observe.ts";
import { addNode, addService, denied, jst, MINUTE, NODE, NODE2, rows, startWork, useGuardWorld } from "../helpers/guard.ts";
import { ORIGIN } from "../helpers/gate.ts";

const w = useGuardWorld();

/**
 * 出来事をゲートウェイの数え方に渡す
 * @param event 出来事
 * @param at 時刻
 * @returns 答え
 */
function send(event: unknown, at: number) {
  return observe(w.gate.env, event, at, w.gate.deps);
}

/**
 * 止めた記録を読む
 * @returns stops の行
 */
function stops() {
  return rows(w, "SELECT kind, scope, target, signal, measured, threshold, rules_version, by, external_sources FROM stops ORDER BY id");
}

describe("止めるのはシステム", () => {
  it("タスク 1 つを止める", async () => {
    await startWork(w, "builder");
    await startWork(w, "reviewer", NODE2);
    const ticket = await w.gate.staff.builder.guard.issueToken(NODE, "ws-builder", jst(9));
    const reviewerBefore = await w.gate.staff.reviewer.book.status(jst(10));
    expect(await send(denied(), jst(10))).toMatchObject({ action: "stop", scope: "task", target: NODE });
    expect(await rows(w, `SELECT status, assignee FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "stopped", assignee: "president" }]);
    // 社員は止まらず、タスクを離れて次を取れる
    expect(await w.gate.staff.builder.book.status(jst(10))).toMatchObject({ state: "working", nodeId: null });
    expect(await rows(w, "SELECT node_id, result FROM work_entries")).toEqual([{ node_id: NODE, result: "stopped" }]);
    expect(await w.gate.staff.builder.guard.checkToken(ticket.jti, "ws-builder", jst(10))).toBe("revoked");
    expect(await w.gate.staff.reviewer.book.status(jst(10))).toEqual(reviewerBefore);
    expect(await stops()).toEqual([
      { kind: "stop", scope: "task", target: NODE, signal: "rule_denied", measured: 1, threshold: 1, rules_version: 0, by: "system", external_sources: "[]" },
    ]);
  });

  it("社員 1 人を止める", async () => {
    await startWork(w, "builder");
    const other = await w.gate.staff.builder.guard.issueToken(NODE2, "ws-builder", jst(9));
    await send(denied(NODE), jst(10));
    await addNode(w, NODE2, "builder");
    await w.gate.staff.builder.book.take({ nodeId: NODE2, title: "次", scope: "office" }, null, jst(10, 1));
    await w.gate.staff.builder.book.heartbeat(jst(10, 58));
    expect(await send(denied(NODE2, "/root"), jst(10, 59))).toMatchObject({ action: "stop", scope: "staff", target: "builder" });
    expect((await w.gate.staff.builder.book.status(jst(11))).state).toBe("stopped");
    expect(w.gate.staff.builder.workspace).toContain("restart");
    expect(await w.gate.staff.builder.guard.checkToken(other.jti, "ws-builder", jst(11))).toBe("revoked");
    // 止めていた間は勤怠に stopped で残る
    await w.gate.staff.builder.book.resume(jst(11));
    expect(await rows(w, "SELECT kind, started_at, reason FROM attendance WHERE staff_id = 'builder' ORDER BY started_at")).toContainEqual({ kind: "stopped", started_at: jst(10, 59), reason: "guard_stop" });
  });

  it("サービス 1 つを止める", async () => {
    await addService(w, "shop", "web_app");
    const deploy = { type: "deploy_result", serviceId: "shop", kind: "web", deployedAt: jst(10), baselineRate: 0.02, responses: 30, failures: 2 };
    expect(await send(deploy, jst(10, 5))).toMatchObject({ action: "stop", scope: "service", target: "shop" });
    expect(w.gate.deps.rollbacks).toEqual(["shop"]);
    // 止めている間に届いた返事では、重ねて止めない
    await send({ ...deploy, responses: 10, failures: 5 }, jst(10, 6));
    expect(await stops()).toHaveLength(1);
  });

  it("Web アプリを戻せなかった事を通知に残す", async () => {
    await addService(w, "shop", "web_app");
    w.gate.deps.rollback = () => Promise.reject(new Error("GitHub につながっていない"));
    const deploy = { type: "deploy_result", serviceId: "shop", kind: "web", deployedAt: jst(10), baselineRate: 0.02, responses: 30, failures: 2 };
    expect(await send(deploy, jst(10, 5))).toMatchObject({ action: "stop", scope: "service" });
    expect(await stops()).toMatchObject([{ scope: "service", target: "shop" }]);
    expect(await rows(w, "SELECT level, kind FROM notices ORDER BY kind")).toEqual([
      { level: "stop", kind: "guard_rollback_failed" },
      { level: "stop", kind: "guard_stop" },
    ]);
  });

  it("2 倍を超えない", async () => {
    await addService(w, "shop", "web_app");
    await send({ type: "deploy_result", serviceId: "shop", kind: "web", deployedAt: jst(10), baselineRate: 0.04, responses: 100, failures: 6 }, jst(10, 5));
    expect(w.gate.deps.rollbacks).toEqual([]);
    expect(await rows(w, "SELECT * FROM stops WHERE kind = 'stop'")).toEqual([]);
  });

  it("全体を止める", async () => {
    w.clock.advance(2 * 60 * MINUTE);
    const headers = await w.gate.signIn();
    for (const id of ["president", "builder", "reviewer"] as const) await startWork(w, id, id === "builder" ? NODE : null);
    const before = await rows(w, "SELECT version FROM vault WHERE name = 'session_signing'");
    expect(before).toEqual([{ version: 1 }]);
    expect(await send({ type: "chain_broken", year: 2030 }, jst(10))).toMatchObject({ action: "stop", scope: "office", signal: "certain_fraud" });
    for (const id of ["president", "builder", "reviewer"] as const) expect((await w.gate.staff[id].book.status(jst(10))).state).toBe("stopped");
    // セッションはすべて切れ、作る鍵は新しい版に替わり、外の鍵は入れ直すまで使えない
    expect((await w.gate.request("/api/v1/guard/state", { headers })).status).toBe(401);
    expect(await rows(w, "SELECT version, revoked_at FROM vault WHERE name = 'session_signing' ORDER BY version")).toEqual([
      { version: 1, revoked_at: jst(10) },
      { version: 2, revoked_at: null },
    ]);
    expect(await w.gate.office.keysHeld()).toBe(true);
    expect(await rows(w, "SELECT level, kind FROM notices WHERE kind = 'guard_stop'")).toEqual([{ level: "stop", kind: "guard_stop" }]);
    expect(w.gate.audits.map((a) => a.action)).toContain("guard.stop");
  });
});

describe("社員を止めるシグナル", () => {
  it("外部の文章を読んだ後", async () => {
    await startWork(w, "builder");
    await send({ type: "external_read", staffId: "builder", nodeId: NODE, source: "https://example.com/post" }, jst(10));
    expect(await send({ type: "sensitive_access", staffId: "builder", nodeId: NODE, item: "address" }, jst(10, 1))).toMatchObject({ action: "stop", scope: "staff" });
    expect((await w.gate.staff.builder.book.status(jst(10, 2))).state).toBe("stopped");
    expect(await stops()).toMatchObject([{ scope: "staff", signal: "exfiltration", external_sources: '["https://example.com/post"]' }]);
  });
});

describe("全体を止めるシグナル", () => {
  it("作業トークンの横取り", async () => {
    await startWork(w, "builder");
    const ticket = await w.gate.staff.builder.guard.issueToken(NODE, "ws-builder", jst(9));
    expect(await verifyWorkToken(w.gate.env, "builder", ticket.jti, "ws-builder", jst(9, 30), w.gate.deps)).toBeUndefined();
    await expect(verifyWorkToken(w.gate.env, "builder", ticket.jti, "ws-other", jst(9, 31), w.gate.deps)).rejects.toThrow(AppError);
    expect(await stops()).toMatchObject([{ scope: "office", signal: "certain_fraud" }]);
    // 全体を止めた後は、発行した先からでも使えない
    await expect(verifyWorkToken(w.gate.env, "builder", ticket.jti, "ws-builder", jst(9, 32), w.gate.deps)).rejects.toThrow(AppError);
  });

  it("怪しい動きが重なる", async () => {
    await send({ type: "login", country: "US", newCountry: true }, jst(10));
    for (let n = 0; n < 25; n += 1) await send({ type: "owner_info_read", item: "address" }, jst(10, 10) + n * 10_000);
    expect(await rows(w, "SELECT kind, scope, signal, measured FROM stops ORDER BY id")).toEqual([
      { kind: "near", scope: "office", signal: "stacked_suspicion", measured: 16 },
      { kind: "stop", scope: "office", signal: "stacked_suspicion", measured: 21 },
    ]);
  });
});

describe("誤って止めない", () => {
  it("偽の証明が大量に届く", async () => {
    await startWork(w, "builder");
    const fake = `${await w.gate.access.sign()}x`;
    const statuses = new Set<number>();
    for (let n = 0; n < 1000; n += 1) {
      const res = await w.gate.request("/api/v1/guard/state", { headers: { "Cf-Access-Jwt-Assertion": fake, "CF-Connecting-IP": "203.0.113.9" } });
      statuses.add(res.status);
    }
    expect([...statuses].toSorted((a, b) => a - b)).toEqual([401, 403]);
    expect(await rows(w, "SELECT * FROM stops")).toEqual([]);
    expect((await w.gate.staff.builder.book.status(jst(10))).state).toBe("working");
  });

  it("新しい国からのログインだけ", async () => {
    const login = async (country: string) => {
      const res = await w.gate.request("/api/v1/sessions", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await w.gate.access.sign(), Origin: ORIGIN, "CF-IPCountry": country } });
      expect(res.status).toBe(201);
    };
    await login("JP");
    w.clock.advance(MINUTE);
    await login("US");
    expect(await rows(w, "SELECT kind FROM notices")).toEqual([{ kind: "unusual_login" }]);
    expect(await rows(w, "SELECT * FROM stops")).toEqual([]);
    // 数え方には新しい国のログインとして入っている
    expect(await w.gate.office.observe({ type: "owner_info_read", item: "address" }, w.clock.now(), DEFAULT_THRESHOLDS)).toMatchObject({ action: "none" });
  });
});

describe("止めた記録", () => {
  const manual: StopInput = { scope: "staff", target: "builder", signal: "manual", measured: 0, threshold: 0, rulesVersion: 0, recentOps: [], externalSources: [], by: "owner" };

  it("効かせる所が途中で失敗しても、止めた記録と失敗が残る", async () => {
    await startWork(w, "builder");
    w.gate.staff.builder.guard.halt = () => Promise.reject(new Error("ワークスペースに届かない"));
    await w.gate.staff.builder.book.heartbeat(jst(9, 59));
    await send({ type: "external_read", staffId: "builder", nodeId: NODE, source: "https://example.com/" }, jst(10));
    await expect(send({ type: "sensitive_access", staffId: "builder", nodeId: NODE, item: "address" }, jst(10, 1))).rejects.toThrow(AppError);
    expect(await stops()).toMatchObject([{ kind: "stop", scope: "staff", target: "builder", signal: "exfiltration" }]);
    expect(await rows(w, "SELECT level, kind FROM notices ORDER BY kind")).toEqual([
      { level: "stop", kind: "guard_stop" },
      { level: "stop", kind: "guard_stop_failed" },
    ]);
    expect(w.gate.audits.map((a) => a.action)).toEqual(["guard.stop", "guard.stop_failed"]);
  });

  it("同じ相手への止めが同時に 2 つ来ても、記録は 1 行", async () => {
    await startWork(w, "builder");
    const ids = await Promise.all([applyStop(w.gate.env, manual, jst(10), w.gate.deps), applyStop(w.gate.env, manual, jst(10), w.gate.deps)]);
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await stops()).toHaveLength(1);
  });

  it("記録が残る", async () => {
    await startWork(w, "builder");
    for (let n = 0; n < 23; n += 1) await send({ type: "tool_call", staffId: "builder" }, jst(9, 30) + n * 1000);
    await send(denied(NODE), jst(10));
    await addNode(w, NODE2, "builder");
    await w.gate.staff.builder.book.take({ nodeId: NODE2, title: "次", scope: "office" }, null, jst(10, 1));
    await send(denied(NODE2, "/root"), jst(10, 2));
    const [stop] = await rows(w, "SELECT id, scope, signal, measured, threshold, rules_version, model FROM stops WHERE scope = 'staff'");
    expect(stop).toMatchObject({ scope: "staff", signal: "staff_rule_denied", measured: 2, threshold: 2, rules_version: 0, model: "claude-opus-5-5" });
    const record = w.gate.audits.find((a) => a.action === "guard.stop" && a.target === stop?.["id"]);
    const detail = z.object({ recentOps: z.array(z.object({ type: z.string() }).loose()) }).parse(record?.detail);
    expect(detail.recentOps).toHaveLength(20);
    expect(detail.recentOps.at(-1)).toMatchObject({ type: "rule_denied", target: "/root" });
  });

  it("近かった", async () => {
    await startWork(w, "builder");
    await w.d1.DB.batch(
      Array.from({ length: 7 }, (_, d) =>
        w.d1.DB.prepare("INSERT INTO staff_buckets (id, staff_id, bucket_at, tokens, tool_calls, on_duty) VALUES (?, 'builder', ?, 1000, 10, 1)").bind(
          `0190f4a8-0000-7000-8000-0000000002${String(d).padStart(2, "0")}`,
          jst(10) - (d + 1) * 24 * 60 * MINUTE,
        ),
      ),
    );
    expect(await send({ type: "usage", staffId: "builder", tokens: 4000 }, jst(10))).toMatchObject({ action: "near", measured: 4000, threshold: 5000 });
    await send({ type: "usage", staffId: "builder", tokens: 100 }, jst(10, 1));
    expect(await rows(w, "SELECT kind, scope, target, signal FROM stops")).toEqual([{ kind: "near", scope: "staff", target: "builder", signal: "token_rate" }]);
    expect(await rows(w, "SELECT level FROM notices WHERE kind = 'guard_near'")).toEqual([{ level: "warn" }]);
  });
});

describe("タスクを止めるシグナル", () => {
  it("1 つのタスクの最長時間", async () => {
    await startWork(w, "builder");
    const ticket = await w.gate.staff.builder.guard.issueToken(NODE, "ws-builder", jst(9));
    await w.gate.staff.builder.book.heartbeat(jst(9, 59));
    await w.gate.staff.builder.book.stop(jst(10));
    await w.gate.staff.builder.book.resume(jst(10, 30));
    await checkOverruns(w.gate.env, jst(13, 29), w.gate.deps);
    expect(await stops()).toEqual([]);
    await checkOverruns(w.gate.env, jst(13, 30), w.gate.deps);
    expect(await stops()).toMatchObject([{ scope: "task", target: NODE, signal: "task_overrun", measured: 4 * 60 * MINUTE }]);
    expect(await w.gate.staff.builder.book.status(jst(13, 31))).toMatchObject({ state: "working", nodeId: null });
    expect(await rows(w, `SELECT status, assignee FROM nodes WHERE id = '${NODE}'`)).toEqual([{ status: "stopped", assignee: "president" }]);
    expect(await w.gate.staff.builder.guard.checkToken(ticket.jti, "ws-builder", jst(13, 31))).toBe("revoked");
  });
});
