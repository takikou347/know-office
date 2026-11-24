// 費用の推移と累計のルート。Claude API の額と Cloudflare の見込みを日本時間の月ごとに足し、ホームの今月の費用と合わせる (画面の全体の画面の一覧、エージェントの費用)
import { cloudflareMonthMicroUsd, WORKERS_PAID_MICRO_USD } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const HOUR = 3_600_000;
const USAGE = "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd) VALUES (?, ?, 'builder', NULL, 'office', 'm', 0, 0, 0, 0, ?)";
const TOTAL = "INSERT INTO daily_totals (staff_id, day, clock_in, clock_out, worked_ms, extension_ms, call_ms, stopped_ms, waiting_ms, reasons) VALUES (?, ?, 1, 2, ?, 0, 0, 0, 0, '[]')";

/**
 * UUID v7 の形の ID を番号から作る
 * @param n 番号
 * @returns ID
 */
const usageId = (n: number) => `019a7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const Month = z.object({ month: z.string(), claudeMicroUsd: z.number(), cloudflareMicroUsd: z.number(), totalMicroUsd: z.number() }).strict();
const History = z.object({ data: z.object({ months: z.array(Month), claudeMicroUsd: z.number(), cloudflareMicroUsd: z.number(), totalMicroUsd: z.number() }).strict() }).loose();

let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  // 日本時間の 2027 年 1 月 16 日 10 時
  d1 = await createTestD1();
  gate = await createTestGate({ clock: fixedClock(Date.UTC(2027, 0, 16, 1)), d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

describe("費用の推移", () => {
  it("年をまたいで月ごとに Claude API と Cloudflare を分けて足し、使わなかった月も並べ、累計とホームの今月の費用が合う", async () => {
    // 日本時間の 11 月 1 日 0 時ちょうどは 11 月、その 1 ミリ秒前は 10 月
    const nov = Date.UTC(2026, 9, 31, 15);
    const usage = d1.REC_2026.prepare(USAGE);
    await d1.REC_2026.batch([usage.bind(usageId(1), nov - 1, 100), usage.bind(usageId(2), nov, 2_000_000), usage.bind(usageId(3), nov + 5 * HOUR, 500_000)]);
    // 日本時間の 1 月 1 日 0 時は 2027 年の置き場
    await d1.REC_2027.prepare(USAGE).bind(usageId(4), Date.UTC(2026, 11, 31, 15), 300_000).run();
    const total = d1.DB.prepare(TOTAL);
    await d1.DB.batch([total.bind("builder", "2026-11-02", 30 * HOUR), total.bind("reviewer", "2026-11-03", 10 * HOUR), total.bind("builder", "2027-01-05", 2 * HOUR)]);

    const res = await gate.request("/api/v1/records/costs", { headers });
    expect(res.status).toBe(200);
    const history = History.parse(await res.json()).data;
    expect(history.months).toEqual([
      { month: "2026-10", claudeMicroUsd: 100, cloudflareMicroUsd: WORKERS_PAID_MICRO_USD, totalMicroUsd: 100 + WORKERS_PAID_MICRO_USD },
      { month: "2026-11", claudeMicroUsd: 2_500_000, cloudflareMicroUsd: cloudflareMonthMicroUsd(40 * HOUR), totalMicroUsd: 2_500_000 + cloudflareMonthMicroUsd(40 * HOUR) },
      { month: "2026-12", claudeMicroUsd: 0, cloudflareMicroUsd: WORKERS_PAID_MICRO_USD, totalMicroUsd: WORKERS_PAID_MICRO_USD },
      { month: "2027-01", claudeMicroUsd: 300_000, cloudflareMicroUsd: WORKERS_PAID_MICRO_USD, totalMicroUsd: 300_000 + WORKERS_PAID_MICRO_USD },
    ]);
    expect(history.totalMicroUsd).toBe(history.months.reduce((sum, m) => sum + m.totalMicroUsd, 0));
    expect(history.claudeMicroUsd + history.cloudflareMicroUsd).toBe(history.totalMicroUsd);

    const home = z.object({ data: z.object({ monthCostMicroUsd: z.number() }).loose() }).parse(await (await gate.request("/api/v1/dashboard", { headers })).json()).data;
    expect(home.monthCostMicroUsd).toBe(history.months.at(-1)?.totalMicroUsd);
  });

  it("記録が無ければ今月の Workers Paid だけを返す", async () => {
    const history = History.parse(await (await gate.request("/api/v1/records/costs", { headers })).json()).data;
    expect(history.months).toEqual([{ month: "2027-01", claudeMicroUsd: 0, cloudflareMicroUsd: WORKERS_PAID_MICRO_USD, totalMicroUsd: WORKERS_PAID_MICRO_USD }]);
  });

  it("CSV は月ごとの内訳と累計の行を返す", async () => {
    await d1.REC_2027.prepare(USAGE).bind(usageId(5), Date.UTC(2027, 0, 2), 1_234_567).run();
    const res = await gate.request("/api/v1/records/costs/export", { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect((await res.text()).trim().split("\r\n")).toEqual(["month,claude_usd,cloudflare_usd,total_usd", "2027-01,1.234567,5.000000,6.234567", "total,1.234567,5.000000,6.234567"]);
  });
});
