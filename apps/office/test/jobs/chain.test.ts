// 毎日の定期ジョブが、全部の年の監査ログのつなぎを確かめ、書き換わっていれば確かな不正として全体を止める (ログインと記録の 3.4)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChains } from "../../src/gate/jobs/daily.ts";
import { appendAudit, type ChainCheck, GENESIS_HASH, verifyChain } from "../../src/gate/ledger/audit.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const HOUR = 60 * 60_000;
// 日本時間の 2027 年 1 月 1 日 0 時
const NEW_YEAR = Date.UTC(2026, 11, 31, 15, 0, 0);
let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;

// 2026 年の 2 件と、前の年の最後のハッシュから続く 2027 年の 2 件を置く
beforeEach(async () => {
  clock = fixedClock(NEW_YEAR - 3 * HOUR);
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  let prev = GENESIS_HASH;
  for (const at of [NEW_YEAR - 2 * HOUR, NEW_YEAR - HOUR]) prev = (await appendAudit(d1.REC_2026, prev, { at, actor: "system", action: "test.old", target: String(at), scope: "office" }, clock)).hash;
  const last2026 = prev;
  for (const at of [NEW_YEAR + HOUR, NEW_YEAR + 2 * HOUR]) prev = (await appendAudit(d1.REC_2027, prev, { at, actor: "system", action: "test.new", target: String(at), scope: "office" }, clock)).hash;
  await d1.DB.batch([
    d1.DB.prepare("INSERT INTO record_years (year, binding, state, first_hash, last_hash) VALUES (2026, 'REC_2026', 'readonly', NULL, ?)").bind(last2026),
    d1.DB.prepare("INSERT INTO record_years (year, binding, state, first_hash, last_hash) VALUES (2027, 'REC_2027', 'writing', ?, NULL)").bind(last2026),
  ]);
  clock.advance(6 * HOUR);
});
afterEach(() => d1.dispose());

/**
 * 止めた記録と止めた通知を読む
 * @returns stops と notices の行
 */
async function stopped(): Promise<{ stops: unknown[]; notices: unknown[] }> {
  const stops = (await d1.DB.prepare("SELECT scope, signal FROM stops ORDER BY id").all()).results;
  const notices = (await d1.DB.prepare("SELECT kind FROM notices WHERE kind = 'guard_stop'").all()).results;
  return { stops, notices };
}

describe("記録のつなぎの見張り", () => {
  it("前の年の途中の行が書き換わると、毎日の確かめが見つけて全体を止め、通知を出す", async () => {
    await d1.REC_2026.prepare("DROP TRIGGER audit_log_no_update").run();
    await d1.REC_2026.prepare("UPDATE audit_log SET target = 'changed' WHERE rowid = 1").run();
    await verifyChains(gate.env, clock, gate.deps);
    expect(await stopped()).toEqual({ stops: [{ scope: "office", signal: "certain_fraud" }], notices: [{ kind: "guard_stop" }] });
  });

  it("どの年もつながっていれば止めない", async () => {
    await verifyChains(gate.env, clock, gate.deps);
    expect(await stopped()).toEqual({ stops: [], notices: [] });
  });

  it("記録 DO に届かない年はエラーログに残すだけで止めず、ほかの年は確かめる", async () => {
    await d1.REC_2027.prepare("DROP TRIGGER audit_log_no_update").run();
    await d1.REC_2027.prepare("UPDATE audit_log SET target = 'changed' WHERE rowid = 2").run();
    const recorder = gate.env.RECORDER.get(gate.env.RECORDER.idFromName("recorder"));
    // 2026 年だけ記録 DO に届かない事にする
    const down = { ...recorder, verify: (year: number) => (year === 2026 ? Promise.reject(new Error("届かない")) : recorder.verify(year)) };
    Object.assign(gate.env, { RECORDER: { idFromName: () => "recorder", get: () => down } });
    await verifyChains(gate.env, clock, gate.deps);
    expect(await stopped()).toEqual({ stops: [{ scope: "office", signal: "certain_fraud" }], notices: [{ kind: "guard_stop" }] });
    expect((await d1.REC_2027.prepare("SELECT code FROM error_events").all()).results).toEqual([{ code: "chain_verify_failed" }]);
  });

  it("確かめている途中で記録 DO が行を足しても、合わないと見ずに止めない", async () => {
    // 1 行ずつ読み、読むたびに記録 DO の代わりに今の年へ 1 行足す
    const startLast = (await d1.REC_2027.prepare("SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1").first<{ hash: string }>())?.hash ?? "";
    let prev = startLast;
    let added = 0;
    const appending = new Proxy(d1.REC_2027, {
      get(target, prop): unknown {
        if (prop !== "prepare") return Reflect.get(target, prop) as unknown;
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("ORDER BY rowid LIMIT")) return statement;
          return {
            bind: (...values: unknown[]) => ({
              all: async () => {
                const read = await statement.bind(...values).all();
                const at = NEW_YEAR + (3 + added) * HOUR;
                prev = (await appendAudit(d1.REC_2027, prev, { at, actor: "system", action: "test.during", target: String(at), scope: "office" }, clock)).hash;
                added += 1;
                return read;
              },
            }),
          };
        };
      },
    });
    const first = (await d1.DB.prepare("SELECT first_hash FROM record_years WHERE year = 2027").first<{ first_hash: string }>())?.first_hash ?? GENESIS_HASH;
    const recorder = gate.env.RECORDER.get(gate.env.RECORDER.idFromName("recorder"));
    const checks: ChainCheck[] = [];
    const during = {
      ...recorder,
      verify: async (year: number) => {
        if (year !== 2027) return recorder.verify(year);
        const check = await verifyChain(appending, first, 1);
        checks.push(check);
        return check;
      },
    };
    Object.assign(gate.env, { RECORDER: { idFromName: () => "recorder", get: () => during } });
    await verifyChains(gate.env, clock, gate.deps);
    expect(added).toBeGreaterThan(0);
    // 始めた時の最後の行で止め、後から足された行を読まない
    expect(checks).toEqual([{ ok: true, brokenAt: null, lastHash: startLast }]);
    expect(await stopped()).toEqual({ stops: [], notices: [] });
  });

  it("1 度合わなくても、確かめ直して合えば止めない", async () => {
    const calls: number[] = [];
    const answers: ChainCheck[] = [{ ok: false, brokenAt: "x", lastHash: GENESIS_HASH }, { ok: true, brokenAt: null, lastHash: GENESIS_HASH }];
    const real = gate.env.RECORDER.get(gate.env.RECORDER.idFromName("recorder"));
    const flaky = { ...real, verify: (year: number) => (calls.push(year), Promise.resolve(year === 2027 ? (answers.shift() ?? answers[0]) : { ok: true, brokenAt: null, lastHash: GENESIS_HASH })) };
    Object.assign(gate.env, { RECORDER: { idFromName: () => "recorder", get: () => flaky } });
    await verifyChains(gate.env, clock, gate.deps);
    expect(calls).toEqual([2026, 2027, 2027]);
    expect(await stopped()).toEqual({ stops: [], notices: [] });
  });

  it("確かめ直しても合わなければ止める", async () => {
    const calls: number[] = [];
    const real = gate.env.RECORDER.get(gate.env.RECORDER.idFromName("recorder"));
    const broken = { ...real, verify: (year: number) => (calls.push(year), Promise.resolve({ ok: year !== 2027, brokenAt: year === 2027 ? "x" : null, lastHash: GENESIS_HASH })) };
    Object.assign(gate.env, { RECORDER: { idFromName: () => "recorder", get: () => broken } });
    await verifyChains(gate.env, clock, gate.deps);
    expect(calls).toEqual([2026, 2027, 2027]);
    expect(await stopped()).toEqual({ stops: [{ scope: "office", signal: "certain_fraud" }], notices: [{ kind: "guard_stop" }] });
  });
});
