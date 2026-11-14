import type { DaySummary } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { daySummaryText, jstTime, workEntryRow } from "../src/screen/format.ts";

const MINUTE = 60_000;

const day: DaySummary = {
  staffId: "builder",
  day: "2026-11-13",
  clockIn: "2026-11-13T00:00:00.000Z",
  clockOut: "2026-11-13T08:10:00.000Z",
  workedMs: 475 * MINUTE,
  extensionMs: 10 * MINUTE,
  callMs: 0,
  stoppedMs: 15 * MINUTE,
  waitingMs: 0,
  reasons: ["extension:checkpoint_wait", "leave_early:schedule", "stopped:guard_stop"],
};

describe("時刻と勤怠の文", () => {
  it("協定世界時の 0 時は日本時間の 9 時として出す", () => {
    expect(jstTime("2026-11-14T00:00:00Z")).toBe("9:00");
    expect(jstTime("2026-11-14T15:05:00Z")).toBe("0:05");
  });

  it("勤怠の上の 1 行は 出勤、退勤、働いた時間、延長、止められていた時間 の順で、理由があれば添える", () => {
    expect(daySummaryText(day)).toBe("11/13 (金) 出勤 9:00、退勤 17:10、働いた 7 時間 55 分、延長 10 分 (チェックポイントを待った)、止められていた 15 分 (自動停止)");
    expect(daySummaryText({ ...day, clockOut: null, extensionMs: 0, stoppedMs: 0, workedMs: 90 * MINUTE + 59_999, reasons: [] })).toBe(
      "11/13 (金) 出勤 9:00、退勤 まだ、働いた 1 時間 30 分、延長 0 分、止められていた 0 分",
    );
    expect(daySummaryText({ ...day, clockIn: null, clockOut: null, workedMs: 0, extensionMs: 0, stoppedMs: 0, reasons: ["off:owner_instruction"] })).toBe(
      "11/13 (金) 出勤 なし、退勤 なし、働いた 0 分、延長 0 分、止められていた 0 分",
    );
  });

  it("タスクの行は日本時間の時刻、掛かった分、サービス、結果の言葉にする", () => {
    const row = workEntryRow({
      id: "0190f4a8-0000-7000-8000-0000000000b1",
      nodeId: "0190f4a8-0000-7000-8000-000000000001",
      scope: "knowidea-ui",
      title: "DiffView の行番号を直す",
      startedAt: "2026-11-13T00:00:00.000Z",
      endedAt: "2026-11-13T01:40:00.000Z",
      activeMs: 100 * MINUTE,
      result: "continued",
    });
    expect(row).toEqual({ key: "0190f4a8-0000-7000-8000-0000000000b1", start: "9:00", end: "10:40", task: "DiffView の行番号を直す", minutes: 100, service: "knowidea-ui", result: "次の日へ続く" });
  });
});
