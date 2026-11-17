// 開発担当のツール docs_pr_open の入力。仕様が変わった時に、設計書のリポジトリへ PR を出す (開発の回し方の 3.6)
import { z } from "../zod.ts";

/** docs_pr_open の入力。name はブランチ名 `ko/<タスク ID の頭 8 字>-<name>` の後ろで、設計書のリポジトリのブランチになる */
export const DocsPrOpenTool = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(40),
    title: z.string().min(1).max(200),
    body: z.string().max(20_000),
  })
  .strict();

/** docs_pr_open の入力の型 */
export type DocsPrOpenTool = z.infer<typeof DocsPrOpenTool>;
