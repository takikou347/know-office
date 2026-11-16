// 監査ログの一覧。年ごとの置き場から選んで新しい順に返し、前の年も同じ形で読める (ログインと記録の 3.5、API の system)
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appendAudit, GENESIS_HASH } from "../../src/gate/ledger/audit.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const HOUR = 60 * 60_000;
// 日本時間の 2027 年 1 月 1 日 0 時
const NEW_YEAR = Date.UTC(2026, 11, 31, 15, 0, 0);
let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
// テストごとに時刻、空の D1、ゲートウェイを作り、年をまたいだ記録を置いてからログインする
beforeEach(async () => {
  clock = fixedClock(NEW_YEAR - 3 * HOUR);
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  // 2026 年の最後の 2 件と、2027 年の最初の 2 件。前の年の最後のハッシュから次の年が続く
  let prev = GENESIS_HASH;
  for (const at of [NEW_YEAR - 2 * HOUR, NEW_YEAR - HOUR]) {
    clock.advance(1000);
    prev = (await appendAudit(d1.REC_2026, prev, { at, actor: "system", action: "test.old", target: String(at), scope: "office" }, clock)).hash;
  }
  const last2026 = prev;
  for (const at of [NEW_YEAR + HOUR, NEW_YEAR + 2 * HOUR]) {
    clock.advance(1000);
    prev = (await appendAudit(d1.REC_2027, prev, { at, actor: "system", action: "test.new", target: String(at), scope: "office" }, clock)).hash;
  }
  await d1.DB.batch([
    d1.DB.prepare("INSERT INTO record_years (year, binding, state, first_hash, last_hash) VALUES (2026, 'REC_2026', 'readonly', NULL, ?)").bind(last2026),
    d1.DB.prepare("INSERT INTO record_years (year, binding, state, first_hash, last_hash) VALUES (2027, 'REC_2027', 'writing', ?, NULL)").bind(last2026),
  ]);
  clock.advance(3 * HOUR);
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const AuditList = z.object({
  data: z.array(z.object({ id: z.string(), at: z.string(), action: z.string(), target: z.string().nullable(), detail: z.unknown(), traceId: z.string().nullable() }).loose()),
  meta: z.object({ next: z.string().nullable() }).loose(),
});

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 */
async function stepUp(): Promise<void> {
  await d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(clock.now() + 15 * 60_000).run();
}

/**
 * 監査ログの一覧を読む
 * @param query クエリ
 * @returns 返事
 */
function list(query: string): Promise<Response> {
  return gate.request(`/api/v1/audit-logs${query}`, { headers });
}

const Verification = z.object({ data: z.object({ ok: z.boolean(), brokenAt: z.string().nullable() }).strict() }).loose();

/**
 * 年のハッシュチェーンを確かめる
 * @param year 年
 * @returns 返事
 */
function verify(year: number): Promise<Response> {
  return gate.request("/api/v1/audit-logs/verify", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ year }) });
}

describe("書き換えられない記録", () => {
  it("記録が書き換わる", async () => {
    const [row] = (await d1.REC_2027.prepare("SELECT id FROM audit_log ORDER BY id LIMIT 1").all<{ id: string }>()).results;
    // 書き換えはトリガーが断るので、トリガーを外して書き換えた事にする
    await d1.REC_2027.prepare("DROP TRIGGER audit_log_no_update").run();
    await d1.REC_2027.prepare("UPDATE audit_log SET target = 'changed' WHERE id = ?").bind(row?.id).run();
    const res = await verify(2027);
    expect(res.status).toBe(200);
    expect(Verification.parse(await res.json()).data).toEqual({ ok: false, brokenAt: row?.id });
    // つなぎが合わない事は確かな不正のシグナルで、全体を止める
    const stops = await d1.DB.prepare("SELECT kind, scope, signal FROM stops").all();
    expect(stops.results).toEqual([{ kind: "stop", scope: "office", signal: "certain_fraud" }]);
  });
});

describe("記録の量", () => {
  it("前の年を読む", async () => {
    await stepUp();
    const res = await list("?from=2026-12-31&to=2027-01-01");
    expect(res.status).toBe(200);
    const { data, meta } = AuditList.parse(await res.json());
    expect(data.map((row) => row.action)).toEqual(["test.new", "test.new", "test.old", "test.old"]);
    expect(data.at(-1)).toMatchObject({ at: new Date(NEW_YEAR - 2 * HOUR).toISOString(), target: String(NEW_YEAR - 2 * HOUR), detail: null, traceId: null });
    expect(meta.next).toBeNull();
    expect(gate.audits.at(-1)).toMatchObject({ action: "audit_log.read", detail: { from: "2026-12-31", to: "2027-01-01" } });
  });

  it("期間で年の置き場を選び、年をまたいでも limit ごとにページを送る", async () => {
    await stepUp();
    const old = AuditList.parse(await (await list("?from=2026-12-31&to=2026-12-31")).json());
    expect(old.data.map((row) => row.action)).toEqual(["test.old", "test.old"]);
    const first = AuditList.parse(await (await list("?limit=3")).json());
    expect(first.data.map((row) => row.action)).toEqual(["test.new", "test.new", "test.old"]);
    const second = AuditList.parse(await (await list(`?limit=3&cursor=${String(first.meta.next)}`)).json());
    expect(second.data.map((row) => row.action)).toEqual(["test.old"]);
    expect(second.meta.next).toBeNull();
  });

  it("年のハッシュチェーンを確かめ、合えば ok を返して何も止めない。置き場の無い年は 404", async () => {
    const res = await verify(2027);
    expect(res.status).toBe(200);
    expect(Verification.parse(await res.json()).data).toEqual({ ok: true, brokenAt: null });
    expect(await d1.DB.prepare("SELECT COUNT(*) AS n FROM stops").first("n")).toBe(0);
    clock.advance(60_000);
    expect((await verify(2030)).status).toBe(404);
  });

  it("確かめは重いので、送信元ごとに 1 分 1 回までにし、超えたら 429 と Retry-After", async () => {
    expect((await verify(2027)).status).toBe(200);
    const again = await verify(2026);
    expect(again.status).toBe(429);
    expect(Problem.parse(await again.json()).code).toBe("rate_limited");
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
    // ほかのルートは同じ分でも使える
    expect((await gate.request("/api/v1/storage", { headers })).status).toBe(200);
    clock.advance(60_000);
    expect((await verify(2026)).status).toBe(200);
  });

  it("パスキーの確認が無ければ 401 step_up_required、期間が逆さなら 422", async () => {
    const without = await list("");
    expect(without.status).toBe(401);
    expect(Problem.parse(await without.json()).code).toBe("step_up_required");
    await stepUp();
    expect((await list("?from=2027-01-02&to=2027-01-01")).status).toBe(422);
  });
});
