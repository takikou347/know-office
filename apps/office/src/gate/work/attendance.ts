// 勤怠の D1 への読み書き。勤務の時刻、その日の指示、日ごとの集計の作り直し、訂正 (社員と勤怠の 2 章、3.6)
import type { D1Database } from "@cloudflare/workers-types";
import {
  AppError,
  AttendanceKind,
  AttendanceReason,
  type Clock,
  DEFAULT_SCHEDULE,
  newId,
  type StaffId,
  WORKED_KINDS,
  WorkSchedule,
} from "@know-office/core";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { attendance, dailyTotals, dayOrders, notices, settings } from "../db/main.ts";

/** D1 の attendance の 1 行 */
export type AttendanceRow = typeof attendance.$inferSelect;

/** D1 の day_orders の 1 行 */
export type DayOrderRow = typeof dayOrders.$inferSelect;

/** 訂正の値。元の行を置き換える。時刻は協定世界時のミリ秒 */
export const CorrectionValues = z
  .object({
    kind: AttendanceKind,
    startedAt: z.number().int(),
    endedAt: z.number().int(),
    reason: AttendanceReason,
    note: z.string().min(1),
  })
  .strict()
  .refine((v) => v.startedAt < v.endedAt, { message: "終わりは始まりより後にする" });

/** 訂正の値の型 */
export type CorrectionValues = z.infer<typeof CorrectionValues>;

/** daily_totals の reasons。`<出来事>:<理由>` を並べる */
const Reasons = z.array(z.string());

/** 勤怠の行に出ない理由の頭。早い退勤と休みは区分を作らないので、集計を作り直す時に前の集計から引き継ぐ */
const OFF_ROW_REASONS = ["leave_early:", "off:"] as const;

/**
 * 前の集計の理由のうち、勤怠の行に出ない物だけを返す。行に出る理由は効いている行から作り直す
 * @param stored daily_totals の reasons の値
 * @returns 引き継ぐ理由
 */
function keptReasons(stored: unknown): string[] {
  const parsed = Reasons.safeParse(stored);
  return parsed.success ? parsed.data.filter((r) => OFF_ROW_REASONS.some((head) => r.startsWith(head))) : [];
}

/**
 * その時刻だけを返す Clock を作る。ID の UUID v7 に時刻を入れる
 * @param now 今の時刻
 * @returns Clock
 */
export function clockAt(now: number): Clock {
  return { now: () => now };
}

/**
 * 勤務の時刻を設定 `workday.schedule` の最新の版から読む。無いか形が違えば初期値
 * @param db D1 の DB
 * @returns 勤務の時刻
 */
export async function loadSchedule(db: D1Database): Promise<WorkSchedule> {
  const [row] = await drizzle(db)
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, "workday.schedule"), eq(settings.scope, "office")))
    .orderBy(desc(settings.version))
    .limit(1);
  // value は JSON のカラムで、drizzle が読んだ時に戻す。形が違えば初期値で動かす
  const parsed = WorkSchedule.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_SCHEDULE;
}

/**
 * その日の取り消されていない指示を、出した順に読む
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @param day 日本時間の日
 * @returns 指示の行
 */
export async function loadOrders(db: D1Database, staffId: StaffId, day: string): Promise<DayOrderRow[]> {
  const orm = drizzle(db);
  const where = and(eq(dayOrders.staffId, staffId), eq(dayOrders.day, day));
  const rows = await orm.select().from(dayOrders).where(and(where, isNull(dayOrders.cancels))).orderBy(dayOrders.createdAt);
  const cancelled = new Set((await orm.select({ cancels: dayOrders.cancels }).from(dayOrders).where(and(where, isNotNull(dayOrders.cancels)))).map((r) => r.cancels));
  return rows.filter((r) => !cancelled.has(r.id));
}

/**
 * 訂正された行を訂正の行で置き換えた、その日の勤怠を始まりの順に返す
 * @param rows その日の attendance の行
 * @returns 効いている行
 */
export function effectiveRows(rows: AttendanceRow[]): AttendanceRow[] {
  const corrected = new Set(rows.flatMap((r) => (r.corrects ? [r.corrects] : [])));
  return rows.filter((r) => !corrected.has(r.id)).toSorted((a, b) => a.startedAt - b.startedAt);
}

/** 集計した日の値 */
type Totals = typeof dailyTotals.$inferInsert;

/**
 * 効いている行から日ごとの集計を作る。退勤していなければ clock_out は null
 * @param rows 効いている行
 * @param base 集計の行の残り (社員 ID、日、出勤の時刻、退勤したか、行に出ない理由)
 * @param base.staffId 社員 ID
 * @param base.day 日本時間の日
 * @param base.clockIn 行がまだ無い時の出勤の時刻
 * @param base.out 退勤したか
 * @param base.reasons 行に出ない理由 (早い退勤、休み)
 * @returns 集計の行と、区分が重なったか
 */
export function sumDay(rows: AttendanceRow[], base: { staffId: StaffId; day: string; clockIn: number | null; out: boolean; reasons: string[] }): { totals: Totals; overlap: boolean } {
  const ms = { scheduled: 0, extension: 0, call: 0, stopped: 0, waiting: 0 };
  const reasons = new Set(base.reasons);
  let overlap = false;
  let lastEnd = -Infinity;
  for (const row of rows) {
    ms[row.kind] += row.endedAt - row.startedAt;
    if (row.kind !== "scheduled" && row.reason) reasons.add(`${row.kind}:${row.reason}`);
    // どの 1 分も 1 つの区分にしか入らない
    if (row.startedAt < lastEnd) overlap = true;
    lastEnd = Math.max(lastEnd, row.endedAt);
  }
  const first = rows[0];
  return {
    overlap,
    totals: {
      staffId: base.staffId,
      day: base.day,
      clockIn: first ? first.startedAt : base.clockIn,
      clockOut: base.out && first ? lastEnd : null,
      workedMs: WORKED_KINDS.reduce((sum, kind) => sum + ms[kind], 0),
      extensionMs: ms.extension,
      callMs: ms.call,
      stoppedMs: ms.stopped,
      waitingMs: ms.waiting,
      reasons: [...reasons].toSorted(),
    },
  };
}

/**
 * 日ごとの集計を attendance から作り直す。区分が重なっていれば通知を出す
 * @param db D1 の DB
 * @param base 社員 ID、日、出勤の時刻、退勤したか、行に出ない理由
 * @param base.staffId 社員 ID
 * @param base.day 日本時間の日
 * @param base.clockIn 行がまだ無い時の出勤の時刻
 * @param base.out 退勤したか
 * @param base.reasons 行に出ない理由 (早い退勤、休み)。前の集計の理由に足す
 * @param base.noticeId 区分が重なった時の通知の ID。渡すと、同じ ID で何度作り直しても通知は 1 件
 * @param now 今の時刻
 * @returns 無し
 */
export async function rebuildDailyTotals(
  db: D1Database,
  base: { staffId: StaffId; day: string; clockIn: number | null; out: boolean; reasons: string[]; noticeId?: string },
  now: number,
): Promise<void> {
  const orm = drizzle(db);
  const rows = await orm.select().from(attendance).where(and(eq(attendance.staffId, base.staffId), eq(attendance.day, base.day)));
  const [before] = await orm.select({ reasons: dailyTotals.reasons }).from(dailyTotals).where(and(eq(dailyTotals.staffId, base.staffId), eq(dailyTotals.day, base.day)));
  const { noticeId, ...sumBase } = base;
  const { totals, overlap } = sumDay(effectiveRows(rows), { ...sumBase, reasons: [...keptReasons(before?.reasons), ...base.reasons] });
  const { staffId: _s, day: _d, ...rest } = totals;
  const upsert = orm.insert(dailyTotals).values(totals).onConflictDoUpdate({ target: [dailyTotals.staffId, dailyTotals.day], set: rest });
  if (overlap) {
    const body = `${base.staffId} の ${base.day} の勤怠で、同じ時刻が 2 つの区分に入っている`;
    const notice = orm
      .insert(notices)
      .values({ id: noticeId ?? newId(clockAt(now)), at: now, level: "warn", kind: "attendance_overlap", title: "勤怠の区分が重なっている", body, scope: "office" })
      .onConflictDoNothing();
    await orm.batch([upsert, notice]);
    return;
  }
  await upsert;
}

/**
 * 勤怠の行を訂正する。元の行は残し、corrects に元の ID を持つ行を足して、日ごとの集計を作り直す。読んでから書くまでの間に行が入らないよう、社員 DO の中から呼ぶ
 * @param db D1 の DB
 * @param staffId 社員 ID。ほかの社員の行は無い物として扱う
 * @param originalId 訂正する行の ID
 * @param input 置き換える値
 * @param now 今の時刻
 * @returns 足した行の ID
 * @throws validation_failed 値の形が違う時
 * @throws not_found この社員の元の行が無い時
 * @throws conflict 元の行がもう訂正されているか、直した区分がほかの区分と重なる時
 */
export async function correctAttendance(db: D1Database, staffId: StaffId, originalId: string, input: unknown, now: number): Promise<{ id: string }> {
  const parsed = CorrectionValues.safeParse(input);
  if (!parsed.success) throw new AppError("validation_failed", "訂正の値の形が違う");
  const values = parsed.data;
  const orm = drizzle(db);
  const [original] = await orm
    .select()
    .from(attendance)
    .where(and(eq(attendance.id, originalId), eq(attendance.staffId, staffId)));
  if (!original) throw new AppError("not_found", "訂正する勤怠の行が無い");
  const rows = await orm.select().from(attendance).where(and(eq(attendance.staffId, staffId), eq(attendance.day, original.day)));
  // 訂正は 1 つの行に 1 度だけ。直し直す時は訂正の行を訂正する
  if (rows.some((r) => r.corrects === original.id)) throw new AppError("conflict", "この行はもう訂正されている");
  const row: AttendanceRow = {
    id: newId(clockAt(now)),
    staffId: original.staffId,
    day: original.day,
    kind: values.kind,
    startedAt: values.startedAt,
    endedAt: values.endedAt,
    reason: values.reason,
    corrects: original.id,
    note: values.note,
    createdAt: now,
  };
  const [before] = await orm.select().from(dailyTotals).where(and(eq(dailyTotals.staffId, staffId), eq(dailyTotals.day, original.day)));
  const { totals, overlap } = sumDay(effectiveRows([...rows, row]), {
    staffId,
    day: original.day,
    clockIn: before?.clockIn ?? null,
    out: typeof before?.clockOut === "number",
    reasons: keptReasons(before?.reasons),
  });
  if (overlap) throw new AppError("conflict", "直した区分がほかの区分と重なる");
  const { staffId: _s, day: _d, ...rest } = totals;
  await orm.batch([orm.insert(attendance).values(row), orm.insert(dailyTotals).values(totals).onConflictDoUpdate({ target: [dailyTotals.staffId, dailyTotals.day], set: rest })]);
  return { id: row.id };
}
