// 毎日 4 時の写し (wrangler d1 export) の間は今の年の記録の D1 への要求が止まるので、記録 DO が監査ログの行を溜め、書けるようになったら順に書き、つなぎを割らない (ログインと記録の 3.6)
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, verifyChain } from "../../src/gate/ledger/audit.ts";
import { appendOrHold, flushHeld, type HeldAudit, type HeldStore } from "../../src/gate/ledger/held.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeEach(async () => {
  d1 = await createTestD1();
});
afterEach(() => d1.dispose());

const YEAR = 2026;
const clock = fixedClock(Date.UTC(2026, 10, 14, 19, 0, 0));
const entry = (n: number) => ({ at: clock.now() + n, actor: "owner", action: "node.create", target: String(n), scope: "office" as const, detail: { n } });

/**
 * DO の storage の代わり。年ごとに順の番号で並べる
 * @returns 溜める所
 */
function memoryStore(): HeldStore & { rows: Map<string, HeldAudit> } {
  const rows = new Map<string, HeldAudit>();
  return {
    rows,
    list: (year) => Promise.resolve([...rows.values()].filter((r) => r.year === year).toSorted((a, b) => a.seq - b.seq)),
    put: (row) => (rows.set(`${String(row.year)}:${String(row.seq)}`, row), Promise.resolve()),
    remove: (row) => (rows.delete(`${String(row.year)}:${String(row.seq)}`), Promise.resolve()),
  };
}

/**
 * 書き出しの間の D1 の代わり。down の間は書く文が落ちる。afterWrite なら書けた後に落ちる
 * @param db 包む D1
 * @returns 包んだ D1 と切り替え
 */
function exporting(db: D1Database) {
  const state = { down: true, afterWrite: false, failAfter: Infinity, writes: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop): unknown {
      if (prop !== "prepare") return Reflect.get(target, prop) as unknown;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("INSERT")) return statement;
        return {
          bind: (...values: unknown[]) => ({
            run: async () => {
              if (state.down && !state.afterWrite) throw new Error("D1_ERROR: export in progress");
              if (state.writes >= state.failAfter) throw new Error("D1_ERROR: export in progress");
              const result = await statement.bind(...values).run();
              state.writes += 1;
              if (state.down && state.afterWrite) throw new Error("D1_ERROR: network lost");
              return result;
            },
          }),
        };
      };
    },
  });
  return { db: wrapped, state };
}

/**
 * 監査ログの行の数
 * @returns 行の数
 */
async function written(): Promise<number> {
  return (await d1.REC_2026.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())?.n ?? 0;
}

describe("写しの間の監査ログ", () => {
  it("今の年の D1 が書き出しで止まっている間は、記録 DO が行を溜め、書けるようになったら順に書いてつなぎを割らない", async () => {
    const store = memoryStore();
    const { db, state } = exporting(d1.REC_2026);
    const first = await appendOrHold(db, store, YEAR, GENESIS_HASH, entry(1), clock);
    const second = await appendOrHold(db, store, YEAR, first.hash, entry(2), clock);
    expect([first.held, second.held]).toEqual([true, true]);
    expect(await written()).toBe(0);
    state.down = false;
    expect(await flushHeld(db, store, YEAR)).toBe(0);
    expect(await written()).toBe(2);
    expect(store.rows.size).toBe(0);
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toEqual({ ok: true, brokenAt: null, lastHash: second.hash });
  });

  it("溜めた行が残っている間に来た行は、溜めた行を先に書いてから書く", async () => {
    const store = memoryStore();
    const { db, state } = exporting(d1.REC_2026);
    const first = await appendOrHold(db, store, YEAR, GENESIS_HASH, entry(1), clock);
    state.down = false;
    const second = await appendOrHold(db, store, YEAR, first.hash, entry(2), clock);
    expect(second.held).toBe(false);
    const { results } = await d1.REC_2026.prepare("SELECT target FROM audit_log ORDER BY rowid").all();
    expect(results).toEqual([{ target: "1" }, { target: "2" }]);
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toMatchObject({ ok: true });
  });

  it("書けたのに落ちたと返った行を溜めても、書き戻しで 2 度書かない", async () => {
    const store = memoryStore();
    const { db, state } = exporting(d1.REC_2026);
    state.afterWrite = true;
    const first = await appendOrHold(db, store, YEAR, GENESIS_HASH, entry(1), clock);
    expect(first.held).toBe(true);
    state.down = false;
    await flushHeld(db, store, YEAR);
    expect(await written()).toBe(1);
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toMatchObject({ ok: true });
  });

  it("書き戻しの途中で落ちたら、残りを溜めたまま次に続ける", async () => {
    const store = memoryStore();
    const { db, state } = exporting(d1.REC_2026);
    let prev = GENESIS_HASH;
    for (const n of [1, 2, 3]) prev = (await appendOrHold(db, store, YEAR, prev, entry(n), clock)).hash;
    state.down = false;
    state.failAfter = 1;
    expect(await flushHeld(db, store, YEAR)).toBe(2);
    expect(await written()).toBe(1);
    state.failAfter = Infinity;
    expect(await flushHeld(db, store, YEAR)).toBe(0);
    expect(await written()).toBe(3);
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toEqual({ ok: true, brokenAt: null, lastHash: prev });
  });
});
