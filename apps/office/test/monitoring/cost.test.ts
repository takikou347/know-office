// 記録に出す値: 使った額をいつでも見えるよう、ダッシュボードが今月 (日本時間) の使った額を返す (サービスと拡張の 3.4、ルートの一覧の 1.12)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - 9, m);
const USAGE = "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd) VALUES (?, ?, 'builder', NULL, ?, 'm', 0, 0, 0, 0, ?)";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  clock = fixedClock(at(16, 10));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

/**
 * ダッシュボードの今月の費用を読む
 * @returns 今月の使った額 (マイクロドル)
 */
async function monthCost(): Promise<number> {
  const res = await gate.request("/api/v1/dashboard", { headers });
  expect(res.status).toBe(200);
  return z.object({ data: z.object({ monthCostMicroUsd: z.number() }).loose() }).parse(await res.json()).data.monthCostMicroUsd;
}

describe("記録に出す値", () => {
  it("今月の費用", async () => {
    const usage = d1.REC_2026.prepare(USAGE);
    // 日本時間の 11 月 1 日 0 時ちょうどは今月、その 1 ミリ秒前は先月。サービスの分も office の分も足す
    const monthStart = Date.UTC(2026, 9, 31, 15);
    await d1.REC_2026.batch([
      usage.bind("019a7b00-0000-7000-8000-0000000000b1", monthStart, "office", 1_500_000),
      usage.bind("019a7b00-0000-7000-8000-0000000000b2", monthStart - 1, "office", 9_000_000),
      usage.bind("019a7b00-0000-7000-8000-0000000000b3", at(16, 9), "019a7b00-0000-7000-8000-00000000c0de", 250_000),
    ]);
    expect(await monthCost()).toBe(1_750_000);
    // 使うたびに今の額に足され、読み直すと出る
    await usage.bind("019a7b00-0000-7000-8000-0000000000b6", at(16, 9, 30), "office", 5).run();
    expect(await monthCost()).toBe(1_750_005);
  });

  it("使っていない月の費用は 0、年をまたいだ 1 月はその年の記録から足す", async () => {
    expect(await monthCost()).toBe(0);
    // 日本時間の 2027 年 1 月 1 日 0 時ちょうどは 2027 年、その 1 ミリ秒前は 2026 年の記録
    const newYear = Date.UTC(2026, 11, 31, 15);
    await d1.REC_2026.prepare(USAGE).bind("019a7b00-0000-7000-8000-0000000000b4", newYear - 1, "office", 7_000_000).run();
    await d1.REC_2027.prepare(USAGE).bind("019a7b00-0000-7000-8000-0000000000b5", newYear, "office", 300_000).run();
    clock.advance(newYear + 60_000 - clock.now());
    headers = await gate.signIn();
    expect(await monthCost()).toBe(300_000);
  });
});
