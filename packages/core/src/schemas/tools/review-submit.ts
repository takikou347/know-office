// レビュー担当のツール review_submit の入力。今のレビューのタスクに承認か差し戻しを出す (タスクとレビューの 1.2、3.1 の 4)
import { CommitSha } from "../review.ts";
import { z } from "../zod.ts";

/** review_submit の入力。headSha は読んだ先のコミットで、レビューの今の先と違えば断る。行への指摘は 8.7 で GitHub に写す */
export const ReviewSubmitTool = z
  .object({
    verdict: z.enum(["approve", "reject"]),
    summary: z.string().min(1).max(20_000),
    // 社員に見せるツールの説明。読んだ物と判断を出す物を同じコミットに結ぶ
    headSha: CommitSha.describe("確かめたコミット。確かめたワークスペースで `git rev-parse HEAD` を走らせた値 (40 字の 16 進数) を渡す。レビューの今の先と違えば断られるので、読み直してから出し直す"),
  })
  .strict();

/** review_submit の入力の型 */
export type ReviewSubmitTool = z.infer<typeof ReviewSubmitTool>;
