import { describe, expect, it } from "vitest";
import { daySummaryText, jstTime } from "../src/screen/format.ts";

describe("時刻と勤怠の文", () => {
  it("協定世界時の 0 時は日本時間の 9 時として出す", () => {
    expect(jstTime("2026-11-14T00:00:00Z")).toBe("9:00");
    expect(jstTime("2026-11-14T15:05:00Z")).toBe("0:05");
  });

  it("勤怠の上の 1 行は 出勤、退勤、働いた時間、延長、止められていた時間 の順で、理由があれば添える", () => {
    expect(
      daySummaryText({
        date: "11/14 (金)",
        in: "9:00",
        out: "17:10",
        workedMinutes: 475,
        overtimeMinutes: 10,
        overtimeReason: "区切りを待った",
        stoppedMinutes: 20,
        stoppedReason: "自動の守り",
      }),
    ).toBe("11/14 (金) 出勤 9:00、退勤 17:10、働いた 7 時間 55 分、延長 10 分 (区切りを待った)、止められていた 20 分 (自動の守り)");
    expect(
      daySummaryText({ date: "11/14 (金)", in: "9:00", out: "17:00", workedMinutes: 480, overtimeMinutes: 0, stoppedMinutes: 0 }),
    ).toBe("11/14 (金) 出勤 9:00、退勤 17:00、働いた 8 時間、延長 0 分、止められていた 0 分");
  });
});
