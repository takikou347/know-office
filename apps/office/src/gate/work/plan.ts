// その日の勤務の予定。勤務の時刻とその日の指示から、始まりと終わりの時刻を決める (社員と勤怠の 2 章、3.3、3.4)
import type { D1Database } from "@cloudflare/workers-types";
import { jstDay, type StaffId } from "@know-office/core";
import { z } from "zod";
import { loadOrders, loadSchedule } from "./attendance.ts";

const DAY_MS = 24 * 60 * 60_000;

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
 * 勤務の時刻とその日の指示から予定を作る
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @param day 日本時間の日
 * @returns 予定。勤務の曜日でなければ null
 */
export async function planDay(db: D1Database, staffId: StaffId, day: string): Promise<Plan | null> {
  const schedule = await loadSchedule(db);
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
