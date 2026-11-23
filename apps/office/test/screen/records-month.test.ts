// 記録の画面の月の選び方と、勤怠を社員と日の表にする組み立てを確かめる (画面の全体の画面の一覧)
import type { DaySummary } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { attendanceGrid, monthDays, monthLabel, monthRange, recentMonths } from "../../src/screen/pages/ledger/month.ts";

/**
 * 1 日の勤怠のまとめを作る
 * @param staffId 社員
 * @param day 日
 * @param workedMs 働いたミリ秒
 * @returns まとめ
 */
const summary = (staffId: DaySummary["staffId"], day: string, workedMs: number): DaySummary => ({
  staffId,
  day,
  clockIn: `${day}T00:00:00.000Z`,
  clockOut: `${day}T08:00:00.000Z`,
  workedMs,
  extensionMs: 0,
  callMs: 0,
  stoppedMs: 0,
  waitingMs: 0,
  reasons: [],
});

describe("画面の一覧", () => {
  it("勤怠を月で見る", () => {
    // 選べる月は今月から前へ並び、年をまたぐ
    expect(recentMonths("2026-02-10", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(monthLabel("2026-02")).toBe("2026年2月");
    // 月の端は閏年の 2 月の終わりまで
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    // 今月は今日まで、過ぎた月は終わりの日までを古い日から並べる
    expect(monthDays("2026-11", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(monthDays("2026-09", "2026-11-03")).toHaveLength(30);

    const grid = attendanceGrid(
      ["2026-11-01", "2026-11-02"],
      ["builder", "reviewer"],
      [summary("builder", "2026-11-02", 3_600_000), summary("reviewer", "2026-11-02", 1_800_000), summary("builder", "2026-11-01", 7_200_000)],
    );
    // 日ごとの行に、社員ごとの勤怠を置く。記録の無い日と社員は null
    expect(grid.days.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(grid.days[0]?.cells.builder?.workedMs).toBe(7_200_000);
    expect(grid.days[0]?.cells.reviewer).toBeNull();
    // 社員ごとの月の合計と、出た日の数
    expect(grid.totals).toEqual({ builder: { workedMs: 10_800_000, days: 2 }, reviewer: { workedMs: 1_800_000, days: 1 } });
    // 1 件も無ければ空にし、画面は「データがありません」を出す
    expect(attendanceGrid(["2026-11-01"], ["builder"], []).days).toEqual([]);
  });
});
