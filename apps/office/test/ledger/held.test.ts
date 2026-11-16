// 毎日 4 時の写し (wrangler d1 export) の間は D1 への要求が止まるので、記録 DO が監査ログの行を DO の storage に溜め、書けるようになったら順に書き、つなぎを割らない。DO が起き直した直後も同じ (ログインと記録の 3.5)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../../src/gate/ledger/audit.ts";
import { AuditLedger, HELD_LIMIT, type LedgerStorage } from "../../src/gate/ledger/held.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeEach(async () => {
  d1 = await createTestD1();
});
afterEach(() => d1.dispose());

// 日本時間の 2026 年 11 月 15 日 4 時
const clock = fixedClock(Date.UTC(2026, 10, 14, 19, 0, 0));
// 日本時間の 2027 年 1 月 1 日 0 時
const NEW_YEAR = Date.UTC(2026, 11, 31, 15, 0, 0);
const entry = (n: number, at = clock.now() + n) => ({ at, actor: "owner", action: "node.create", target: String(n), scope: "office" as const, detail: { n } });

/**
 * DO の storage の代わり。DO を作り直しても残る
 * @returns storage の代わり
 */
function memoryStorage(): LedgerStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 置いた値を同じ型で読む代わりの storage
    get: <T,>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    put: (entries) => {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
      return Promise.resolve();
    },
    delete: (keys) => {
      for (const k of keys) data.delete(k);
      return Promise.resolve();
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 置いた値を同じ型で読む代わりの storage
    list: <T,>(prefix: string) => Promise.resolve(new Map([...data.entries()].filter(([k]) => k.startsWith(prefix)).toSorted(([a], [b]) => a.localeCompare(b)) as [string, T][])),
  };
}

/**
 * 書き出しの間の D1 の答え
 * @returns 落ちる Promise
 */
function stopped(): Promise<never> {
  return Promise.reject(new Error("D1_ERROR: export in progress"));
}

/** 止められる D1 の切り替え */
type Switch = { down: boolean; afterWrite: boolean; failAfter: number; writes: number };

/**
 * 書き出しの間の D1 の代わり。down の間はどの要求も落ちる。afterWrite なら書けた後に落ちる
 * @param db 包む D1
 * @returns 包んだ D1 と切り替え
 */
function stoppable(db: D1Database): { db: D1Database; state: Switch } {
  const state: Switch = { down: false, afterWrite: false, failAfter: Infinity, writes: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop): unknown {
      if (prop === "batch") {
        // 包んだ文は本物の文を real に持つので、本物に戻して渡す
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 本物に戻した文を本物の batch に渡す
        return (statements: { real?: unknown }[]) => (state.down ? stopped() : target.batch(statements.map((s) => s.real ?? s) as Parameters<D1Database["batch"]>[0]));
      }
      if (prop !== "prepare") return Reflect.get(target, prop) as unknown;
      return (sql: string) => {
        const statement = target.prepare(sql);
        const bound = (values: unknown[]) => {
          const real = statement.bind(...values);
          return {
            real,
            first: <T,>() => (state.down ? stopped() : real.first<T>()),
            all: () => (state.down ? stopped() : real.all()),
            run: async () => {
              if (state.down && !state.afterWrite) return stopped();
              if (sql.startsWith("INSERT INTO audit_log") && state.writes >= state.failAfter) return stopped();
              const result = await real.run();
              if (sql.startsWith("INSERT INTO audit_log")) state.writes += 1;
              if (state.down && state.afterWrite) throw new Error("D1_ERROR: network lost");
              return result;
            },
          };
        };
        return { ...bound([]), bind: (...values: unknown[]) => bound(values) };
      };
    },
  });
  return { db: wrapped, state };
}

/**
 * 記録 DO の中の記録係を作る。作り直すと覚えた物は消え、storage だけが残る
 * @param storage DO の storage の代わり
 * @param options 止められる D1 と上限
 * @param options.main 本番の DB
 * @param options.rec 年ごとの記録の D1
 * @param options.maxHeld 溜める上限
 * @returns 記録係と、残したエラーの code
 */
function ledgerOf(storage: LedgerStorage, options: { main: D1Database; rec: Record<number, D1Database>; maxHeld?: number }) {
  const errors: string[] = [];
  const ledger = new AuditLedger({
    main: options.main,
    binding: (year) => {
      const db = options.rec[year];
      if (!db) throw new AppError("internal", `REC_${String(year)} が無い`);
      return db;
    },
    storage,
    clock,
    maxHeld: options.maxHeld,
    report: (code) => {
      errors.push(code);
      return Promise.resolve();
    },
  });
  return { ledger, errors };
}

/**
 * 年の記録の行の数
 * @param db 年の D1
 * @returns 行の数
 */
async function written(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())?.n ?? 0;
}

/**
 * その年の最初の行の prev_hash
 * @param year 年
 * @returns record_years の first_hash
 */
async function firstHash(year: number): Promise<string> {
  const row = await d1.DB.prepare("SELECT first_hash FROM record_years WHERE year = ?").bind(year).first<{ first_hash: string | null }>();
  return row?.first_hash ?? "0".repeat(64);
}

describe("写しの間の監査ログ", () => {
  it("DO が起き直した直後に D1 が書き出しで止まっていても、最初の行から溜め、書けるようになったら順に書いてつなぎを割らない", async () => {
    const storage = memoryStorage();
    const main = stoppable(d1.DB);
    const rec = stoppable(d1.REC_2026);
    const warm = ledgerOf(storage, { main: main.db, rec: { 2026: rec.db } });
    await warm.ledger.append(entry(1));
    // 退避されて覚えた物が消えた DO を作り直し、DB と今の年の記録の D1 の両方を止める
    main.state.down = true;
    rec.state.down = true;
    const cold = ledgerOf(storage, { main: main.db, rec: { 2026: rec.db } });
    const second = await cold.ledger.append(entry(2));
    const third = await cold.ledger.append(entry(3));
    expect([second.held, third.held]).toEqual([true, true]);
    // 溜めるたびに warn のログとエラーログに残す。2 行目は先に溜めた行を書き直せなかった事も残す
    expect(cold.errors).toEqual(["audit_held", "audit_flush_failed", "audit_held"]);
    main.state.down = false;
    rec.state.down = false;
    expect(await ledgerOf(storage, { main: main.db, rec: { 2026: rec.db } }).ledger.flush()).toBe(0);
    expect(await written(d1.REC_2026)).toBe(3);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toEqual({ ok: true, brokenAt: null, lastHash: third.hash });
  });

  it("溜めた行が残っている間に来た行は、溜めた行を先に書いてから書く", async () => {
    const storage = memoryStorage();
    const rec = stoppable(d1.REC_2026);
    const { ledger } = ledgerOf(storage, { main: d1.DB, rec: { 2026: rec.db } });
    await ledger.append(entry(0));
    rec.state.down = true;
    expect((await ledger.append(entry(1))).held).toBe(true);
    rec.state.down = false;
    expect((await ledger.append(entry(2))).held).toBe(false);
    const { results } = await d1.REC_2026.prepare("SELECT target FROM audit_log ORDER BY rowid").all();
    expect(results).toEqual([{ target: "0" }, { target: "1" }, { target: "2" }]);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toMatchObject({ ok: true });
  });

  it("書けたのに落ちたと返った行を溜めても、書き戻しで 2 度書かない", async () => {
    const storage = memoryStorage();
    const rec = stoppable(d1.REC_2026);
    const { ledger } = ledgerOf(storage, { main: d1.DB, rec: { 2026: rec.db } });
    await ledger.append(entry(0));
    Object.assign(rec.state, { down: true, afterWrite: true });
    expect((await ledger.append(entry(1))).held).toBe(true);
    Object.assign(rec.state, { down: false, afterWrite: false });
    await ledger.flush();
    expect(await written(d1.REC_2026)).toBe(2);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toMatchObject({ ok: true });
  });

  it("書き直しの途中で落ちたら、残りを溜めたままエラーログに残し、次に続ける", async () => {
    const storage = memoryStorage();
    const rec = stoppable(d1.REC_2026);
    const { ledger, errors } = ledgerOf(storage, { main: d1.DB, rec: { 2026: rec.db } });
    await ledger.append(entry(0));
    rec.state.down = true;
    let last = "";
    for (const n of [1, 2, 3]) last = (await ledger.append(entry(n))).hash;
    rec.state.down = false;
    rec.state.failAfter = rec.state.writes + 1;
    expect(await ledger.flush()).toBe(2);
    expect(errors.at(-1)).toBe("audit_flush_failed");
    expect(await written(d1.REC_2026)).toBe(2);
    rec.state.failAfter = Infinity;
    expect(await ledger.flush()).toBe(0);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toEqual({ ok: true, brokenAt: null, lastHash: last });
  });

  it(`溜めた行が上限 (${String(HELD_LIMIT)} 行) に届いたら、それ以上は溜めずに断る`, async () => {
    const storage = memoryStorage();
    const rec = stoppable(d1.REC_2026);
    const { ledger, errors } = ledgerOf(storage, { main: d1.DB, rec: { 2026: rec.db }, maxHeld: 2 });
    await ledger.append(entry(0));
    rec.state.down = true;
    await ledger.append(entry(1));
    await ledger.append(entry(2));
    await expect(ledger.append(entry(3))).rejects.toMatchObject({ code: "unavailable" });
    expect(errors.at(-1)).toBe("audit_held_full");
    rec.state.down = false;
    expect(await ledger.flush()).toBe(0);
    // 断った行は書かず、つなぎは割れない
    expect(await written(d1.REC_2026)).toBe(3);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toMatchObject({ ok: true });
  });

  it("年をまたぐ時は、前の年の溜めを書き終えるまで新しい年を開かない", async () => {
    const storage = memoryStorage();
    const old = stoppable(d1.REC_2026);
    const { ledger } = ledgerOf(storage, { main: d1.DB, rec: { 2026: old.db, 2027: d1.REC_2027 } });
    await ledger.append(entry(0, NEW_YEAR - 60_000));
    old.state.down = true;
    expect((await ledger.append(entry(1, NEW_YEAR - 30_000))).held).toBe(true);
    await expect(ledger.append(entry(2, NEW_YEAR + 60_000))).rejects.toMatchObject({ code: "unavailable" });
    expect((await d1.DB.prepare("SELECT year FROM record_years ORDER BY year").all()).results).toEqual([{ year: 2026 }]);
    old.state.down = false;
    await ledger.append(entry(2, NEW_YEAR + 60_000));
    expect(await written(d1.REC_2026)).toBe(2);
    // 新しい年は、溜めを書き終えた前の年の最後のハッシュから続く
    const last2026 = await verifyChain(d1.REC_2026, await firstHash(2026));
    expect(last2026).toMatchObject({ ok: true });
    expect(await firstHash(2027)).toBe(last2026.lastHash);
    expect(await verifyChain(d1.REC_2027, await firstHash(2027))).toMatchObject({ ok: true });
  });

  it("D1 に書けた後に storage の最後のハッシュが 1 行前のまま残っても、作り直した DO は D1 の最後の行につなぐ", async () => {
    const storage = memoryStorage();
    const warm = ledgerOf(storage, { main: d1.DB, rec: { 2026: d1.REC_2026 } });
    await warm.ledger.append(entry(0));
    const stale = storage.data.get("last:2026");
    // storage の put だけが落ちる。D1 に書けた行は失敗にしない
    const put = storage.put.bind(storage);
    storage.put = () => Promise.reject(new Error("storage に書けない"));
    const second = await warm.ledger.append(entry(1));
    storage.put = put;
    expect(second.held).toBe(false);
    expect(warm.errors).toContain("audit_remember_failed");
    expect(storage.data.get("last:2026")).toBe(stale);
    // 書いた後、storage を書く前に DO が落ちた形も同じ
    const third = await ledgerOf(storage, { main: d1.DB, rec: { 2026: d1.REC_2026 } }).ledger.append(entry(2));
    storage.data.set("last:2026", second.hash);
    const fourth = await ledgerOf(storage, { main: d1.DB, rec: { 2026: d1.REC_2026 } }).ledger.append(entry(3));
    expect(await written(d1.REC_2026)).toBe(4);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toEqual({ ok: true, brokenAt: null, lastHash: fourth.hash });
    expect(third.held).toBe(false);
  });

  it("溜めた行がある冷えた DO は、溜めた行の最後のハッシュにそのまま続ける", async () => {
    const storage = memoryStorage();
    const rec = stoppable(d1.REC_2026);
    const warm = ledgerOf(storage, { main: d1.DB, rec: { 2026: rec.db } });
    await warm.ledger.append(entry(0));
    rec.state.down = true;
    await warm.ledger.append(entry(1));
    // storage の最後のハッシュが失われても、溜めた行から読む
    storage.data.delete("last:2026");
    const cold = ledgerOf(storage, { main: d1.DB, rec: { 2026: rec.db } });
    const next = await cold.ledger.append(entry(2));
    expect(next.held).toBe(true);
    rec.state.down = false;
    expect(await cold.ledger.flush()).toBe(0);
    expect(await verifyChain(d1.REC_2026, await firstHash(2026))).toEqual({ ok: true, brokenAt: null, lastHash: next.hash });
  });
});
