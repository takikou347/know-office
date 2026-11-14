// サービスごとの記録。時間、タスクの数、費用、トークンを scope で分け、内訳の和が全体と合う事 (サービスと拡張の 3.4)
import { newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { serviceEvents, services, workEntries } from "../../src/gate/db/main.ts";
import { serviceMetrics, usage } from "../../src/gate/db/records.ts";
import { api, at, MINUTE, type WorkWorld, useWork } from "../helpers/work.ts";

const world = useWork();

const Totals = z.object({ workedMs: z.number(), tasks: z.number(), costMicroUsd: z.number(), tokens: z.number(), deploys: z.number(), failureRatio: z.number() });
const Summary = z
  .object({ group: z.enum(["service", "staff"]), rows: z.array(Totals.extend({ key: z.string(), name: z.string() }).strict()), total: Totals.strict() })
  .strict();
type Summary = z.infer<typeof Summary>;

const ADDED = ["workedMs", "tasks", "costMicroUsd", "tokens", "deploys"] as const;

/**
 * 日本時間の 2026-12 の日の時刻を返す。テストごとに日を変え、追記専用の記録が前のテストと混ざらないようにする
 * @param day 日
 * @param h 時
 * @returns 協定世界時のミリ秒
 */
function on(day: number, h: number): number {
  return at(h) + (day - 1) * 24 * 60 * MINUTE;
}

/**
 * サービスを 1 つ置く。登録の流れ (9.2) の代わりに行を直に入れる
 * @param w テストの物
 * @param name サービスの名前
 * @returns サービス ID
 */
async function service(w: WorkWorld, name: string): Promise<string> {
  const id = newId(w.clock);
  await drizzle(w.d1.DB).insert(services).values({ id, name, kind: "library", stage: "operation", repo: `example/${name}`, staffId: "builder", createdAt: w.clock.now() });
  return id;
}

/**
 * タスクを離れた時の 1 行と、その間に使った Claude の量を 1 行ずつ置く
 * @param w テストの物
 * @param input 範囲、社員、時刻、掛けた分、結果、費用、トークン
 * @param input.scope office かサービス ID
 * @param input.staffId 社員
 * @param input.day 2026-12 の日
 * @param input.minutes 掛けた分
 * @param input.result タスクを離れた理由
 * @param input.cost 費用 (100 万分の 1 ドル)
 * @param input.tokens 入力のトークン
 * @returns work_entries の行の ID
 */
async function work(
  w: WorkWorld,
  input: { scope: string; staffId: "president" | "builder" | "reviewer"; day: number; minutes: number; result: "done" | "continued" | "stopped"; cost: number; tokens: number },
): Promise<string> {
  const start = on(input.day, 10);
  const id = newId(w.clock);
  const nodeId = newId(w.clock);
  await drizzle(w.d1.DB)
    .insert(workEntries)
    .values({ id, staffId: input.staffId, day: `2026-12-${String(input.day).padStart(2, "0")}`, nodeId, scope: input.scope, title: "仕事", startedAt: start, endedAt: start + input.minutes * MINUTE, activeMs: input.minutes * MINUTE, result: input.result, corrects: null });
  await drizzle(w.d1.REC_2026)
    .insert(usage)
    .values({ id: newId(w.clock), at: start + MINUTE, staffId: input.staffId, nodeId, scope: input.scope, model: "claude-sonnet-4-5", inputTokens: input.tokens, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: input.cost, requestId: null, waitedMs: null, traceId: null });
  return id;
}

/**
 * 記録の集計を読む
 * @param w テストの物
 * @param query 期間と分け方
 * @returns 集計
 */
async function summary(w: WorkWorld, query: string): Promise<Summary> {
  return Summary.parse(await api(w, "GET", `/api/v1/records/summary?${query}`));
}

describe("サービスごとの記録", () => {
  it("サービスの記録を開く", async () => {
    const ui = await service(world, "knowidea-ui");
    const office = await service(world, "know-office");
    await work(world, { scope: ui, staffId: "builder", day: 2, minutes: 30, result: "done", cost: 1_000, tokens: 100 });
    await work(world, { scope: ui, staffId: "reviewer", day: 2, minutes: 15, result: "continued", cost: 500, tokens: 50 });
    await work(world, { scope: office, staffId: "builder", day: 2, minutes: 60, result: "done", cost: 9_000, tokens: 900 });
    await drizzle(world.d1.DB).insert(serviceEvents).values({ id: newId(world.clock), at: on(2, 12), serviceId: ui, kind: "deploy", by: "builder", detail: null });
    await drizzle(world.d1.REC_2026).insert(serviceMetrics).values({ id: newId(world.clock), serviceId: ui, at: on(2, 12), requests: 200, errors: 5, users: null, reads: null, traceId: null });

    const got = await summary(world, "group=service&from=2026-12-02&to=2026-12-02");
    // knowidea-ui の行には、knowidea-ui のタスクの分だけが入る
    expect(got.rows.find((r) => r.key === ui)).toEqual({ key: ui, name: "knowidea-ui", workedMs: 45 * MINUTE, tasks: 1, costMicroUsd: 1_500, tokens: 170, deploys: 1, failureRatio: 0.025 });
    expect(got.rows.find((r) => r.key === office)).toMatchObject({ name: "know-office", workedMs: 60 * MINUTE, costMicroUsd: 9_000, deploys: 0, failureRatio: 0 });
  });

  it("どのサービスにも入らないタスク", async () => {
    const ui = await service(world, "knowidea-ui");
    // アイデアの検討と組織の決まりの直しは、どのサービスにも入らない
    await work(world, { scope: "office", staffId: "president", day: 3, minutes: 20, result: "done", cost: 700, tokens: 70 });
    await work(world, { scope: "office", staffId: "president", day: 3, minutes: 10, result: "done", cost: 300, tokens: 30 });

    const got = await summary(world, "group=service&from=2026-12-03&to=2026-12-03");
    expect(got.rows.find((r) => r.key === "office")).toEqual({ key: "office", name: "office", workedMs: 30 * MINUTE, tasks: 2, costMicroUsd: 1_000, tokens: 120, deploys: 0, failureRatio: 0 });
    // 何もしていないサービスにも行を出し、office の分は入れない
    expect(got.rows.find((r) => r.key === ui)).toMatchObject({ workedMs: 0, tasks: 0, costMicroUsd: 0, tokens: 0 });
  });

  it("合計が合う", async () => {
    const ui = await service(world, "knowidea-ui");
    const office = await service(world, "know-office");
    await work(world, { scope: ui, staffId: "builder", day: 4, minutes: 30, result: "done", cost: 1_000, tokens: 100 });
    const wrong = await work(world, { scope: office, staffId: "builder", day: 4, minutes: 90, result: "stopped", cost: 2_000, tokens: 200 });
    await work(world, { scope: "office", staffId: "president", day: 4, minutes: 20, result: "done", cost: 700, tokens: 70 });
    // 訂正した行は元の行に代わり、二重に数えない
    await drizzle(world.d1.DB)
      .insert(workEntries)
      .values({ id: newId(world.clock), staffId: "builder", day: "2026-12-04", nodeId: newId(world.clock), scope: office, title: "仕事", startedAt: on(4, 10), endedAt: on(4, 11), activeMs: 60 * MINUTE, result: "done", corrects: wrong });
    await drizzle(world.d1.DB).insert(serviceEvents).values({ id: newId(world.clock), at: on(4, 12), serviceId: office, kind: "deploy", by: "builder", detail: null });

    for (const group of ["service", "staff"] as const) {
      for (const query of [`group=${group}&from=2026-12-04&to=2026-12-04`, `group=${group}`]) {
        const got = await summary(world, query);
        expect(got.group).toBe(group);
        // すべてのサービスと office の分を足した値が、全体の値と合う
        for (const key of ADDED) expect({ query, key, sum: got.rows.reduce((s, r) => s + r[key], 0) }).toEqual({ query, key, sum: got.total[key] });
      }
    }
    const day = await summary(world, "group=service&from=2026-12-04&to=2026-12-04");
    expect(day.total).toMatchObject({ workedMs: 110 * MINUTE, tasks: 3, costMicroUsd: 3_700, tokens: 400, deploys: 1 });

    // CSV も同じ集計で、最後の行が全体
    const res = await world.gate.request("/api/v1/records/summary/export?group=service&from=2026-12-04&to=2026-12-04", { headers: world.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("key,name,workedMs,tasks,costMicroUsd,tokens,deploys,failureRatio");
    expect(lines.at(-1)).toBe(`total,全体,${String(110 * MINUTE)},3,3700,400,1,0`);
    expect(lines).toHaveLength(day.rows.length + 2);
  });
});
