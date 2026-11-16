// エラーログの一覧と、traceId で 1 つの要求を追うルート。年ごとの置き場から読み、追う方はパスキーの確認を求める (ログインと記録の 3.8)
import type { D1Database } from "@cloudflare/workers-types";
import { ErrorEvent, Problem, Trace } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appendAudit, GENESIS_HASH } from "../../src/gate/ledger/audit.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const MINUTE = 60_000;
// 日本時間の 2027 年 1 月 1 日 0 時
const NEW_YEAR = Date.UTC(2026, 11, 31, 15, 0, 0);
const TRACE = "a".repeat(32);
const OTHER = "b".repeat(32);
const NODE = "019a7b00-0000-7000-8000-000000000001";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  clock = fixedClock(NEW_YEAR + 30 * MINUTE);
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

/**
 * エラーログに 1 行置く
 * @param db 置く年の D1
 * @param row 置く値
 * @param row.id 行の ID
 * @param row.at 時刻
 * @param row.source 書いた所
 * @param row.code code
 * @param row.traceId トレース ID
 */
async function addError(db: D1Database, row: { id: string; at: number; source: string; code: string; traceId: string }): Promise<void> {
  await db
    .prepare("INSERT INTO error_events (id, at, source, level, code, message, route, status, fingerprint, trace_id) VALUES (?, ?, ?, 'error', ?, '落ちた', '/api/v1/x', 500, ?, ?)")
    .bind(row.id, row.at, row.source, row.code, "f".repeat(64), row.traceId)
    .run();
}

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 */
async function stepUp(): Promise<void> {
  await d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(clock.now() + 15 * MINUTE).run();
}

const ErrorList = z.object({ data: z.array(ErrorEvent), meta: z.object({ next: z.string().nullable() }).loose() });
const TraceBody = z.object({ data: Trace }).loose();

/**
 * id の頭の時刻の部分だけを変えた UUID v7 を作る
 * @param n 並びの番号
 * @returns UUID v7 の形の ID
 */
function idOf(n: number): string {
  return `019a7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("エラーログの一覧", () => {
  it("年をまたいで新しい順に返し、source と code で絞り、ページを送る", async () => {
    await addError(d1.REC_2026, { id: idOf(1), at: NEW_YEAR - 10 * MINUTE, source: "gate", code: "internal", traceId: TRACE });
    await addError(d1.REC_2027, { id: idOf(2), at: NEW_YEAR + 5 * MINUTE, source: "job", code: "storage_check_failed", traceId: OTHER });
    await addError(d1.REC_2027, { id: idOf(3), at: NEW_YEAR + 10 * MINUTE, source: "gate", code: "internal", traceId: OTHER });
    const all = ErrorList.parse(await (await gate.request("/api/v1/errors", { headers })).json());
    expect(all.data.map((e) => e.id)).toEqual([idOf(3), idOf(2), idOf(1)]);
    // ゲートウェイの決めた code でない、定期ジョブの code もそのまま返す
    expect(all.data[1]).toMatchObject({ source: "job", code: "storage_check_failed", at: new Date(NEW_YEAR + 5 * MINUTE).toISOString(), traceId: OTHER });
    const gateOnly = ErrorList.parse(await (await gate.request("/api/v1/errors?source=gate&code=internal&limit=1", { headers })).json());
    expect(gateOnly.data.map((e) => e.id)).toEqual([idOf(3)]);
    expect(gateOnly.meta.next).toBe(idOf(3));
    const next = ErrorList.parse(await (await gate.request(`/api/v1/errors?source=gate&code=internal&limit=1&cursor=${idOf(3)}`, { headers })).json());
    expect(next.data.map((e) => e.id)).toEqual([idOf(1)]);
    expect(next.meta.next).toBeNull();
  });

  it("期間で年の置き場を選び、日本時間の日で切る", async () => {
    await addError(d1.REC_2026, { id: idOf(1), at: NEW_YEAR - 10 * MINUTE, source: "gate", code: "internal", traceId: TRACE });
    await addError(d1.REC_2027, { id: idOf(2), at: NEW_YEAR + 5 * MINUTE, source: "gate", code: "internal", traceId: TRACE });
    const old = ErrorList.parse(await (await gate.request("/api/v1/errors?from=2026-12-31&to=2026-12-31", { headers })).json());
    expect(old.data.map((e) => e.id)).toEqual([idOf(1)]);
    const fresh = ErrorList.parse(await (await gate.request("/api/v1/errors?from=2027-01-01", { headers })).json());
    expect(fresh.data.map((e) => e.id)).toEqual([idOf(2)]);
  });

  it("from が to より後と、形の違う source、code、カーソルは 422、知らないクエリは 400", async () => {
    const swapped = await gate.request("/api/v1/errors?from=2027-01-02&to=2027-01-01", { headers });
    expect(swapped.status).toBe(422);
    expect(Problem.parse(await swapped.json()).code).toBe("validation_failed");
    for (const query of ["?source=elsewhere", "?cursor=x';--", "?code=Bad%20Code"]) {
      expect({ query, status: (await gate.request(`/api/v1/errors${query}`, { headers })).status }).toEqual({ query, status: 422 });
    }
    expect((await gate.request("/api/v1/errors?unknown=1", { headers })).status).toBe(400);
  });
});

describe("要求をたどる", () => {
  it("同じ traceId の行を時刻の順に返す", async () => {
    await stepUp();
    const old = d1.REC_2026;
    const now = d1.REC_2027;
    await appendAudit(old, GENESIS_HASH, { at: NEW_YEAR - 2 * MINUTE, actor: "owner", action: "node.create", target: NODE, scope: "office", traceId: TRACE }, clock);
    await old.prepare("INSERT INTO messages (id, at, staff_id, node_id, sender, body, body_key, trace_id) VALUES (?, ?, 'reviewer', ?, 'owner', '頼んだ', NULL, ?)").bind(idOf(11), NEW_YEAR - MINUTE, NODE, TRACE).run();
    await now
      .prepare("INSERT INTO node_events (id, at, node_id, staff_id, kind, detail, trace_id) VALUES (?, ?, ?, 'reviewer', 'checkpoint', '{}', ?)")
      .bind(idOf(12), NEW_YEAR + MINUTE, NODE, TRACE)
      .run();
    await now
      .prepare("INSERT INTO tool_calls (id, at, staff_id, node_id, scope, tool, op_kind, target, allowed, reason, ms, trace_id) VALUES (?, ?, 'reviewer', ?, 'office', 'report', 'message.send', NULL, 1, NULL, 5, ?)")
      .bind(idOf(13), NEW_YEAR + 2 * MINUTE, NODE, TRACE)
      .run();
    await now
      .prepare(
        "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, request_id, waited_ms, trace_id) VALUES (?, ?, 'reviewer', ?, 'office', 'claude-opus-5-5', 10, 20, 0, 0, 30, NULL, NULL, ?)",
      )
      .bind(idOf(14), NEW_YEAR + 3 * MINUTE, NODE, TRACE)
      .run();
    await addError(now, { id: idOf(15), at: NEW_YEAR + 4 * MINUTE, source: "workspace", code: "sdk_failed", traceId: TRACE });
    // ほかの要求の行は入れない
    await addError(now, { id: idOf(16), at: NEW_YEAR + 4 * MINUTE, source: "gate", code: "internal", traceId: OTHER });
    const res = await gate.request(`/api/v1/traces/${TRACE}`, { headers });
    expect(res.status).toBe(200);
    const { data } = TraceBody.parse(await res.json());
    expect(data.traceId).toBe(TRACE);
    expect(data.items.map((i) => i.kind)).toEqual(["audit", "message", "node_event", "tool_call", "usage", "error"]);
    expect(data.items.map((i) => i.at)).toEqual([-2, -1, 1, 2, 3, 4].map((m) => new Date(NEW_YEAR + m * MINUTE).toISOString()));
    expect(data.items.map((i) => i.summary)).toEqual([
      "owner が node.create (019a7b00-0000-7000-8000-000000000001)",
      "owner の発言: 頼んだ",
      "reviewer のタスクの出来事 checkpoint",
      "reviewer が report を呼んだ (通した)",
      "reviewer が claude-opus-5-5 を使った (入力 10、出力 20)",
      "workspace の error sdk_failed: 落ちた",
    ]);
    // 監査ログと会話を読んだ事を残す
    expect(gate.audits.filter((a) => a.action === "trace.read").map((a) => [a.actor, a.target])).toEqual([["owner", TRACE]]);
  });

  it("パスキーの確認が無ければ、読む前に 401 で断る", async () => {
    const res = await gate.request(`/api/v1/traces/${TRACE}`, { headers });
    expect(res.status).toBe(401);
    expect(Problem.parse(await res.json()).code).toBe("step_up_required");
    expect(gate.audits.filter((a) => a.action === "trace.read")).toEqual([]);
  });

  it("行が無ければ 404、traceId の形が違えば 422", async () => {
    await stepUp();
    const missing = await gate.request(`/api/v1/traces/${OTHER}`, { headers });
    expect(missing.status).toBe(404);
    expect(Problem.parse(await missing.json()).code).toBe("not_found");
    for (const bad of ["A".repeat(32), "a".repeat(31), `${"a".repeat(31)}'`]) {
      const res = await gate.request(`/api/v1/traces/${encodeURIComponent(bad)}`, { headers });
      expect({ bad, status: res.status }).toEqual({ bad, status: 422 });
    }
  });
});
