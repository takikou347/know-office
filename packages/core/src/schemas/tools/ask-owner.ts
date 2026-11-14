// 3 人のツール ask_owner の入力。費用が増える事と新しい外部連携をオーナーに上げる (タスクとレビューの 1.2)
import { z } from "../zod.ts";

/** ask_owner の入力。target は増える費用の元か、つなぐ外部のサービスの名前 */
export const AskOwnerTool = z
  .object({ kind: z.enum(["external_integration", "cost_increase"]), target: z.string().min(1).max(200), reason: z.string().min(1).max(2000) })
  .strict();

/** ask_owner の入力の型 */
export type AskOwnerTool = z.infer<typeof AskOwnerTool>;
