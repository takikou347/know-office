import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, Health, PROBLEMS, health } from "../src/index.ts";

describe("共通の部品", () => {
  it("どの部分の稼働確認かを返し、Health の形に合う", () => {
    expect(Health.parse(health("gate"))).toEqual({ ok: true, part: "gate" });
    expect(Health.parse(health("workspace"))).toEqual({ ok: true, part: "workspace" });
  });

  it("どの code もステータスと題を持つ", () => {
    for (const code of ERROR_CODES) {
      expect(PROBLEMS[code].status).toBeGreaterThanOrEqual(400);
      expect(PROBLEMS[code].title.length).toBeGreaterThan(0);
    }
  });

  it("AppError は code と項目ごとの理由を持つ", () => {
    const err = new AppError("validation_failed", "title は 200 字まで", { errors: [{ pointer: "#/title", detail: "200 字まで" }] });
    expect(err.code).toBe("validation_failed");
    expect(err.errors).toEqual([{ pointer: "#/title", detail: "200 字まで" }]);
  });
});
