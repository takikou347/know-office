// 開発担当のツール pr_open の入力。今のタスクのブランチからプルリクエストを出す (タスクとレビューの 2 章、3.1 の 3)
import { z } from "../zod.ts";

/** pr_open の入力。ブランチはタスクを取った時にゲートウェイが決めた `ko/<タスク ID>` で、入力に持たない */
export const PrOpenTool = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(20_000),
    docsPr: z.number().int().positive().optional().describe("仕様が変わった時、同じタスクで docs_pr_open で出した設計書の PR の番号。コードの PR と一緒にだけ main に入る"),
  })
  .strict();

/** pr_open の入力の型 */
export type PrOpenTool = z.infer<typeof PrOpenTool>;
