import { describe, expect, it } from "vitest";
import { ROLE_TOOLS, StaffId, StaffJob } from "../src/index.ts";

describe("社員の名簿", () => {
  it("社員 ID は職種の名前か、職種の名前と小文字と数字の 6 字で、オーナーやゲートウェイの名前と重ならない", () => {
    for (const ok of ["president", "builder", "reviewer", "builder-a1b2c3", "reviewer-000000"]) expect(StaffId.safeParse(ok).success).toBe(true);
    for (const ng of ["owner", "system", "github", "builder-", "builder-a1b2c", "builder-a1b2c3d", "builder-A1B2C3", "designer-a1b2c3", "../builder", "builder-a1b2c3/x", ""]) expect(StaffId.safeParse(ng).success).toBe(false);
  });

  it("職種ごとのツールを引ける", () => {
    for (const job of StaffJob.options) expect(ROLE_TOOLS[job]).toContain("checkpoint");
    expect(ROLE_TOOLS.builder).toContain("pr_open");
    expect(ROLE_TOOLS.reviewer).toContain("review_submit");
  });
});
