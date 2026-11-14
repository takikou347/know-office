// 日本時間への直しを確かめる。協定世界時の 15 時が日本時間の次の日の 0 時
import { describe, expect, it } from "vitest";
import { jstDay, jstDayStart, jstYear } from "../src/index.ts";

describe("日本時間", () => {
  it("日本時間の日の始まりを協定世界時のミリ秒で返し、jstDay と往復する", () => {
    expect(jstDayStart("2027-01-01")).toBe(Date.UTC(2026, 11, 31, 15, 0, 0));
    expect(jstDay(jstDayStart("2027-01-01"))).toBe("2027-01-01");
    expect(jstDay(jstDayStart("2027-01-01") - 1)).toBe("2026-12-31");
    expect(jstYear(jstDayStart("2027-01-01"))).toBe(2027);
  });
});
