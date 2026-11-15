// レビュー担当のツール review_submit の入力。今のレビューのタスクに承認か差し戻しを出す (タスクとレビューの 1.2、3.1 の 4)
import { CommitSha } from "../review.ts";
import { z } from "../zod.ts";

/** review_submit の入力。headSha は読んだ先のコミットで、レビューの今の先と違えば断る。行への指摘は 8.7 で GitHub に写す */
export const ReviewSubmitTool = z.object({ verdict: z.enum(["approve", "reject"]), summary: z.string().min(1).max(20_000), headSha: CommitSha }).strict();

/** review_submit の入力の型 */
export type ReviewSubmitTool = z.infer<typeof ReviewSubmitTool>;
