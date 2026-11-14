// 3 人のツール ask_boss の入力。上司に次のタスクを求めるか、困った事を上げる (タスクとレビューの 1.2)
import { z } from "../zod.ts";

/** ask_boss の入力 */
export const AskBossTool = z.object({ reason: z.string().min(1).max(2000) }).strict();

/** ask_boss の入力の型 */
export type AskBossTool = z.infer<typeof AskBossTool>;
