// 記録の画面で選ぶ月と、その月の勤怠を社員と日の表にする組み立て (画面の全体の画面の一覧)
import type { DaySummary, StaffId } from "@know-office/core";

/** 社員 1 人の月の合計。働いた時間と、勤怠のある日の数 */
export type MonthTotal = { workedMs: number; days: number };

/** 勤怠の表の 1 日。社員ごとのその日の勤怠で、無ければ null */
export type GridDay = { day: string; cells: Partial<Record<StaffId, DaySummary | null>> };

/** 月の勤怠の表。日ごとの行と、社員ごとの合計 */
export type AttendanceGrid = { days: GridDay[]; totals: Partial<Record<StaffId, MonthTotal>> };

/**
 * 日本時間の今日から、選べる月を新しい順に並べる
 * @param today 日本時間の今日 YYYY-MM-DD
 * @param count 並べる月の数
 * @returns YYYY-MM の並び
 */
export function recentMonths(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(year, month - 1 - i, 1));
    return at.toISOString().slice(0, 7);
  });
}

/**
 * 月を「2026年11月」の形にする
 * @param month YYYY-MM
 * @returns 年と月の文
 */
export function monthLabel(month: string): string {
  return `${month.slice(0, 4)}年${String(Number(month.slice(5, 7)))}月`;
}

/**
 * 月の始めの日と終わりの日
 * @param month YYYY-MM
 * @returns from と to の YYYY-MM-DD
 */
export function monthRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  // 次の月の 0 日は、その月の終わりの日になる
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * 表に出す月の日を古い順に並べる。今月は今日までにする
 * @param month YYYY-MM
 * @param today 日本時間の今日 YYYY-MM-DD
 * @returns YYYY-MM-DD の並び
 */
export function monthDays(month: string, today: string): string[] {
  const { from, to } = monthRange(month);
  const end = to < today ? to : today;
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); new Date(at).toISOString().slice(0, 10) <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * 月の勤怠を、日ごとの行と社員ごとの列の表にし、社員ごとの合計を出す。勤怠が 1 件も無ければ行を作らない
 * @param days 表に出す日
 * @param staff 列に並べる社員
 * @param rows 入口から読んだ 1 日のまとめ
 * @returns 表
 */
export function attendanceGrid(days: string[], staff: StaffId[], rows: DaySummary[]): AttendanceGrid {
  if (rows.length === 0) return { days: [], totals: {} };
  const byKey = new Map(rows.map((r) => [`${r.day}.${r.staffId}`, r]));
  const totals: Partial<Record<StaffId, MonthTotal>> = {};
  for (const r of rows) {
    const sum = totals[r.staffId] ?? { workedMs: 0, days: 0 };
    totals[r.staffId] = { workedMs: sum.workedMs + r.workedMs, days: sum.days + 1 };
  }
  return {
    days: days.map((day) => ({ day, cells: Object.fromEntries(staff.map((s) => [s, byKey.get(`${day}.${s}`) ?? null])) })),
    totals,
  };
}
