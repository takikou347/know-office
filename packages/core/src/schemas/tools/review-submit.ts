// レビュー担当のツール review_submit の入力。今のレビューのタスクに承認か差し戻しを出す (タスクとレビューの 1.2、3.1 の 4)
import { z } from "../zod.ts";

/** review_submit の入力。行への指摘は 8.7 で GitHub に写す */
export const ReviewSubmitTool = z.object({ verdict: z.enum(["approve", "reject"]), summary: z.string().min(1).max(20_000) }).strict();

/** review_submit の入力の型 */
export type ReviewSubmitTool = z.infer<typeof ReviewSubmitTool>;
