// 1 年分の記録を流し込み、置き場ごとの使った量と、年をまたいだハッシュチェーンを本物の workerd で確かめる (ログインと記録の 3.5、tasks.md の 4.10)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

// テストごとに workerd と D1 を作り直し、前のテストが書いた行に頼らない
let worker: TestWorker;
beforeEach(async () => {
  worker = await startTestWorker();
}, 30_000);
afterEach(() => worker.dispose());

const DAY = 24 * 60 * 60_000;
// 日本時間の 2026 年 1 月 1 日 0 時
const START_2026 = Date.UTC(2025, 11, 31, 15, 0, 0);
const START_2027 = START_2026 + 365 * DAY;
const StorageUse = z.array(z.object({ binding: z.string(), bytes: z.number().int().positive() }));

/**
 * 1 日 1 件の記録を足す。記録 DO が 1 件ずつ順に書くので、頼むのはまとめて出してよい
 * @param from 最初の日の時刻
 * @param days 日数
 */
async function appendDays(from: number, days: number): Promise<void> {
  await Promise.all(
    Array.from({ length: days }, (_, n) =>
      worker.call("append", { at: from + n * DAY + 9 * 60 * 60_000, actor: "system", action: "test.append", target: String(n), scope: "office", detail: { day: n, note: "x".repeat(200) } }),
    ),
  );
}

/**
 * 置き場ごとの使った量を読む
 * @returns バインディングの名前ごとのバイト数
 */
async function sizes(): Promise<Record<string, number>> {
  return Object.fromEntries(StorageUse.parse(await worker.call("size")).map((use) => [use.binding, use.bytes]));
}

describe("記録の量", () => {
  it("使った量はバインドした置き場ごとに返り、記録を足すと増える", async () => {
    const before = await sizes();
    expect(Object.keys(before).toSorted()).toEqual(["DB", "REC_2026", "REC_2027"]);
    await appendDays(START_2026, 60);
    const after = await sizes();
    expect(after["REC_2026"]).toBeGreaterThan(before["REC_2026"] ?? 0);
    expect(after["REC_2027"]).toBe(before["REC_2027"]);
  });

  it("1 年分を流し込んで年をまたいでも、どちらの年のハッシュチェーンも切れない", async () => {
    await appendDays(START_2026, 365);
    await appendDays(START_2027, 3);
    expect(await worker.query("REC_2026", "SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 365 }]);
    expect(await worker.call("verify", 2026)).toMatchObject({ ok: true, brokenAt: null });
    expect(await worker.call("verify", 2027)).toMatchObject({ ok: true, brokenAt: null });
    expect(await worker.query("DB", "SELECT year, state FROM record_years ORDER BY year")).toEqual([
      { year: 2026, state: "readonly" },
      { year: 2027, state: "writing" },
    ]);
  });
});
