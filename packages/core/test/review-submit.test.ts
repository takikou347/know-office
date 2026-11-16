// レビュー担当のツール review_submit の入力の形と、社員に見せる説明 (タスクとレビューの 2 章、3.1 の 4)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ReviewSubmitTool } from "../src/index.ts";

const HEAD = "b".repeat(40);

describe("review_submit の入力", () => {
  it("読んだ先の headSha を 40 字の 16 進数で求める", () => {
    expect(ReviewSubmitTool.safeParse({ verdict: "approve", summary: "読んだ", headSha: HEAD }).success).toBe(true);
    for (const headSha of [undefined, "", "B".repeat(40), "b".repeat(39), `${HEAD}x`]) {
      expect(ReviewSubmitTool.safeParse({ verdict: "approve", summary: "読んだ", headSha }).success).toBe(false);
    }
  });

  it("headSha の説明に、git rev-parse HEAD の値を渡す事を書く", () => {
    expect(JSON.stringify(z.toJSONSchema(ReviewSubmitTool))).toContain("git rev-parse HEAD");
  });
});
