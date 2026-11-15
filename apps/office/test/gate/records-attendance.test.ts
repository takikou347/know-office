// 勤怠の履歴とダッシュボードのルート。記録の画面とダッシュボードが本物の記録から読む (ルートの一覧の 1.4 と 1.12)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - 9, m);

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
 * 日ごとの集計を 1 行足す
 * @param staffId 社員 ID
 * @param day 日本時間の日
 * @param workedMs 働いた時間
 */
async function total(staffId: string, day: string, workedMs: number): Promise<void> {
  await d1.DB.prepare("INSERT INTO daily_totals (staff_id, day, clock_in, clock_out, worked_ms, extension_ms, call_ms, stopped_ms, waiting_ms, reasons) VALUES (?, ?, 1, 2, ?, 0, 0, 0, 0, '[]')")
    .bind(staffId, day, workedMs)
    .run();
}

const Page = z.object({ data: z.array(z.object({ staffId: z.string(), day: z.string(), workedMs: z.number() }).loose()), meta: z.object({ next: z.string().nullable() }).loose() });

/**
 * 勤怠の履歴を読む
 * @param query クエリ
 * @returns 返事
 */
function history(query: string) {
  return gate.request(`/api/v1/records/attendance${query}`, { headers });
}

describe("勤怠の履歴", () => {
  it("期間と社員で絞った勤怠を新しい日から返す", async () => {
    await total("builder", "2026-11-13", 1);
    await total("reviewer", "2026-11-13", 2);
    await total("builder", "2026-11-14", 3);
    await total("builder", "2026-11-15", 4);
    const all = Page.parse(await (await history("?from=2026-11-13&to=2026-11-14")).json());
    expect(all.data.map((r) => `${r.day} ${r.staffId}`)).toEqual(["2026-11-14 builder", "2026-11-13 builder", "2026-11-13 reviewer"]);
    const mine = Page.parse(await (await history("?staffId=reviewer")).json());
    expect(mine.data.map((r) => r.workedMs)).toEqual([2]);
  });

  it("カーソルで次のページを読む", async () => {
    await total("builder", "2026-11-13", 1);
    await total("reviewer", "2026-11-13", 2);
    await total("builder", "2026-11-14", 3);
    const first = Page.parse(await (await history("?limit=2")).json());
    expect(first.data.map((r) => r.workedMs)).toEqual([3, 1]);
    expect(first.meta.next).toBe("2026-11-13.builder");
    const second = Page.parse(await (await history(`?limit=2&cursor=${first.meta.next ?? ""}`)).json());
    expect(second.data.map((r) => r.workedMs)).toEqual([2]);
    expect(second.meta.next).toBeNull();
  });

  it("形の違うカーソルは 400、知らない社員は 422", async () => {
    expect((await history("?cursor=2026-11-13.x' OR 1")).status).toBe(400);
    expect((await history("?staffId=owner")).status).toBe(422);
  });
});

describe("ダッシュボード", () => {
  it("ダッシュボードは社員、未読の通知、承認待ち、今日のタスク、今月の費用を返す", async () => {
    await gate.staff.builder.book.wake(at(16, 9));
    await d1.DB.batch([
      d1.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope, read_at) VALUES ('019a7b00-0000-7000-8000-0000000000f1', 1, 'warn', 'x', '未読', '', 'office', NULL), ('019a7b00-0000-7000-8000-0000000000f2', 2, 'info', 'x', '読んだ', '', 'office', 3)"),
      d1.DB.prepare("INSERT INTO approvals (id, kind, target, payload, status, requested_by, requested_at) VALUES ('019a7b00-0000-7000-8000-0000000000a1', 'merge', 'know-office#1', '{}', 'pending', 'reviewer', 1), ('019a7b00-0000-7000-8000-0000000000a2', 'merge', 'know-office#2', '{}', 'approved', 'reviewer', 1)"),
      d1.DB.prepare(
        "INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES ('019a7b00-0000-7000-8000-0000000000c1', 'task', NULL, 'office', '今の仕事', NULL, 'build', 'builder', 'doing', 1, 'president', 1, 1), ('019a7b00-0000-7000-8000-0000000000c2', 'task', NULL, 'office', '済んだ仕事', NULL, 'build', 'builder', 'done', 1, 'president', 1, 1), ('019a7b00-0000-7000-8000-0000000000c3', 'task', NULL, 'office', '見る仕事', NULL, 'review', 'reviewer', 'review', 1, 'president', 1, 1)",
      ),
    ]);
    const usage = d1.REC_2026.prepare("INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd) VALUES (?, ?, 'builder', NULL, 'office', 'm', 0, 0, 0, 0, ?)");
    // 日本時間の 11 月 1 日 0 時ちょうどは今月、その 1 ミリ秒前は先月
    await d1.REC_2026.batch([usage.bind("019a7b00-0000-7000-8000-0000000000b1", Date.UTC(2026, 9, 31, 15), 1_500_000), usage.bind("019a7b00-0000-7000-8000-0000000000b2", Date.UTC(2026, 9, 31, 15) - 1, 9_000_000), usage.bind("019a7b00-0000-7000-8000-0000000000b3", at(16, 9), 250_000)]);
    const res = await gate.request("/api/v1/dashboard", { headers });
    expect(res.status).toBe(200);
    const data = z.object({ data: z.object({ staff: z.array(z.object({ id: z.string(), role: z.string(), state: z.string() }).loose()), approvals: z.array(z.object({ id: z.string() }).loose()), todayTasks: z.array(z.object({ title: z.string() }).loose()), monthCostMicroUsd: z.number(), notices: z.array(z.object({ title: z.string() }).loose()) }) }).parse(await res.json()).data;
    expect(data.staff.map((s) => `${s.role} ${s.state}`)).toEqual(["社長 off", "開発担当 working", "レビュー担当 off"]);
    expect(data.approvals.map((a) => a.id)).toEqual(["019a7b00-0000-7000-8000-0000000000a1"]);
    expect(data.todayTasks.map((t) => t.title)).toEqual(["今の仕事", "見る仕事"]);
    expect(data.monthCostMicroUsd).toBe(1_750_000);
    expect(data.notices.map((n) => n.title)).toEqual(["未読"]);
  });
});
