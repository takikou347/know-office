// 監査ログのハッシュチェーンを確かめる。データの 3.3、ログインと記録の 3.4
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, GENESIS_HASH, verifyChain } from "../../src/gate/ledger/audit.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

// テストごとに空の D1 を作り、前のテストが書いた行に頼らない
let d1: TestD1;
beforeEach(async () => {
  d1 = await createTestD1();
});
afterEach(() => d1.dispose());

const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
const entry = (action: string) => ({ at: clock.now(), actor: "owner", action, target: "s1", scope: "office", detail: { n: 1 }, traceId: "a".repeat(32) });

/**
 * 監査ログに行を順に足す
 * @param n 足す数
 * @returns 足した行の id と hash
 */
async function appendMany(n: number): Promise<{ id: string; hash: string }[]> {
  const rows: { id: string; hash: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    clock.advance(1000);
    rows.push(await appendAudit(d1.REC_2026, rows.at(-1)?.hash ?? GENESIS_HASH, entry("session.create"), clock));
  }
  return rows;
}

/**
 * 塊を読んだ数を数える D1 を作る
 * @param db 包む D1
 * @param afterChunk 塊を 1 つ読んだ後に呼ぶ
 * @returns 包んだ D1 と、読んだ塊の数
 */
function counting(db: D1Database, afterChunk: () => Promise<void> = () => Promise.resolve()) {
  const state = { chunks: 0 };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- テストで使う prepare だけを包む
  const wrapped = {
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.includes("rowid >")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            all: async <T>() => {
              const result = await bound.all<T>();
              state.chunks += 1;
              await afterChunk();
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    db: wrapped,
    get chunks() {
      return state.chunks;
    },
  };
}

describe("監査ログ", () => {
  it("最初の行は 0 が 64 個の prev_hash から始まり、行ごとに前のハッシュでつながる", async () => {
    const first = await appendAudit(d1.REC_2026, GENESIS_HASH, entry("session.create"), clock);
    const second = await appendAudit(d1.REC_2026, first.hash, entry("session.end"), clock);
    const rows = await d1.REC_2026.prepare("SELECT id, prev_hash, hash FROM audit_log ORDER BY rowid").all<{ id: string; prev_hash: string; hash: string }>();
    expect(rows.results).toEqual([
      { id: first.id, prev_hash: GENESIS_HASH, hash: first.hash },
      { id: second.id, prev_hash: first.hash, hash: second.hash },
    ]);
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toEqual({ ok: true, brokenAt: null, lastHash: second.hash });
  });

  it("記録が書き換わるとハッシュチェーンが合わなくなる", async () => {
    const first = await appendAudit(d1.REC_2026, GENESIS_HASH, entry("session.create"), clock);
    await appendAudit(d1.REC_2026, first.hash, entry("session.end"), clock);
    // 書き換えはトリガーが断るので、トリガーを外して書き換えた事にする
    await d1.REC_2026.prepare("DROP TRIGGER audit_log_no_update").run();
    await d1.REC_2026.prepare("UPDATE audit_log SET detail = '{\"n\":2}' WHERE id = ?").bind(first.id).run();
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toMatchObject({ ok: false, brokenAt: first.id });
  });

  it("塊ごとに読み、前の塊の最後のハッシュから続けて確かめる", async () => {
    const rows = await appendMany(5);
    const reads = counting(d1.REC_2026);
    expect(await verifyChain(reads.db, GENESIS_HASH, 2)).toEqual({ ok: true, brokenAt: null, lastHash: rows.at(-1)?.hash });
    // 5 行を 2 行ずつ読むので 3 回。全件を 1 度に読まない
    expect(reads.chunks).toBe(3);
    await d1.REC_2026.prepare("DROP TRIGGER audit_log_no_update").run();
    await d1.REC_2026.prepare("UPDATE audit_log SET actor = 'staff' WHERE id = ?").bind(rows[3]?.id).run();
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH, 2)).toMatchObject({ ok: false, brokenAt: rows[3]?.id });
  });

  it("確かめている間に足された行は確かめず、合わないとしない", async () => {
    const rows = await appendMany(3);
    let added = false;
    const reads = counting(d1.REC_2026, async () => {
      if (added) return;
      added = true;
      // 最初の塊を読んだ後に、記録 DO が次の行を足す。足した行の前のハッシュは、確かめ始めた時にはまだ読んでいない
      await appendAudit(d1.REC_2026, rows.at(-1)?.hash ?? "", entry("session.end"), clock);
      await d1.REC_2026.prepare("INSERT INTO audit_log (id, at, actor, action, target, scope, detail, prev_hash, hash, trace_id) VALUES ('x', 0, 'a', 'b.c', NULL, 'office', 'null', 'p', 'h', NULL)").run();
    });
    expect(await verifyChain(reads.db, GENESIS_HASH, 2)).toEqual({ ok: true, brokenAt: null, lastHash: rows.at(-1)?.hash });
    expect(added).toBe(true);
  });
});
