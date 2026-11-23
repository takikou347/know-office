// その日の勤務の予定。勤務の時刻とその日の指示から、始まりと終わりの時刻を決める (社員と勤怠の 2 章、3.3、3.4)
import type { D1Database } from "@cloudflare/workers-types";
import { jstDay, OrderKind, type StaffId, WorkSchedule } from "@know-office/core";
import { z } from "zod";
import { loadOrders, loadSchedule } from "./attendance.ts";
import { activeStaffRow } from "./roster.ts";

const DAY_MS = 24 * 60 * 60_000;

/** ゲートウェイが day_orders に足した指示の行 */
export const DayOrder = z
  .object({
    id: z.string(),
    staffId: z.string(),
    day: z.string(),
    kind: OrderKind,
    until: z.number().nullable(),
    source: z.enum(["button", "chat"]),
    cancels: z.string().nullable(),
    createdAt: z.number(),
    // 会話の言葉から足した指示の元の発言。前に足した行と古い呼び手は持たない
    messageId: z.string().nullable().optional(),
  })
  .strict();

/** その日の予定。指示で直した後の時刻 */
export const Plan = z
  .object({
    /** 日本時間の日 */
    day: z.string(),
    start: z.number(),
    /** 所定の勤務の終わり。早める指示で早まる */
    scheduledEnd: z.number(),
    /** 退勤を考え始める時刻。延ばす指示で延びる */
    end: z.number(),
    /** 休みの指示がある */
    off: z.boolean(),
    /** 早める指示がある */
    early: z.boolean(),
  })
  .strict();

/** その日の予定の型 */
export type Plan = z.infer<typeof Plan>;

/**
 * 日本時間の日と HH:MM を協定世界時のミリ秒にする
 * @param day YYYY-MM-DD
 * @param clock HH:MM
 * @returns 協定世界時のミリ秒
 */
function at(day: string, clock: string): number {
  return Date.parse(`${day}T${clock}:00+09:00`);
}

/**
 * 社員の勤務の時刻を読む。社員だけの時刻があればそれを、無ければ全体の時刻を使う
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @returns 勤務の時刻。削除した社員と居ない社員は出勤しないので null
 */
async function scheduleOf(db: D1Database, staffId: StaffId): Promise<WorkSchedule | null> {
  const row = await activeStaffRow(db, staffId);
  if (!row) return null;
  // 社員の行の JSON は書く時に確かめている。読めない形なら全体の時刻で働かせ、出勤を止めない
  const own = WorkSchedule.safeParse(row.schedule);
  return own.success ? own.data : loadSchedule(db);
}

/**
 * 勤務の時刻とその日の指示から予定を作る
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @param day 日本時間の日
 * @returns 予定。勤務の曜日でない時、削除した社員と居ない社員は null
 */
export async function planDay(db: D1Database, staffId: StaffId, day: string): Promise<Plan | null> {
  const schedule = await scheduleOf(db, staffId);
  if (schedule === null) return null;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (!schedule.days.includes(weekday)) return null;
  const start = at(day, schedule.start);
  let end = at(day, schedule.end);
  // 終わりが始まりより前なら、次の日の時刻
  if (end <= start) end += DAY_MS;
  const plan: Plan = { day, start, scheduledEnd: end, end, off: false, early: false };
  for (const o of await loadOrders(db, staffId, day)) {
    if (o.kind === "off") plan.off = true;
    if (o.kind === "leave_early" && o.until !== null && o.until < plan.scheduledEnd) {
      plan.scheduledEnd = o.until;
      plan.end = Math.min(plan.end, o.until);
      plan.early = true;
    }
    if (o.kind === "extend" && o.until !== null) plan.end = Math.max(plan.end, o.until);
  }
  return plan;
}

/**
 * まだ終わっていない最も早い予定を返す。始まりの時刻を処理し終えた日は飛ばす
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @param handledDay 始まりの時刻を処理し終えた最後の日
 * @returns 予定。8 日のうちに無ければ null
 */
export async function upcomingPlan(db: D1Database, staffId: StaffId, now: number, handledDay: string | null): Promise<Plan | null> {
  // 日をまたぐ勤務の時刻のために前の日から見る
  for (let k = -1; k <= 7; k += 1) {
    const day = jstDay(now + k * DAY_MS);
    if (handledDay !== null && day <= handledDay) continue;
    const plan = await planDay(db, staffId, day);
    if (plan && plan.end > now) return plan;
  }
  return null;
}
