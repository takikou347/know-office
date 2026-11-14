// 開発担当のツール pr_open の入力。今のタスクのブランチからプルリクエストを出す (タスクとレビューの 1.2、3.1 の 3)
import { z } from "../zod.ts";

/** pr_open の入力。name はブランチ名 `ko/<タスク ID の頭 8 字>-<name>` の後ろ */
export const PrOpenTool = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(40),
    title: z.string().min(1).max(200),
    body: z.string().max(20_000),
  })
  .strict();

/** pr_open の入力の型 */
export type PrOpenTool = z.infer<typeof PrOpenTool>;
