// 社長のツール staff_request の入力。社員の追加と役の変更をオーナーに求める (タスクとレビューの 1.2)
import { StaffId } from "../workday.ts";
import { z } from "../zod.ts";

/** staff_request の入力。役の変更は target に社員 ID を置く */
export const StaffRequestTool = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staff_add"), role: z.string().min(1).max(100), bossId: StaffId, reason: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("role_change"), target: StaffId, role: z.string().min(1).max(100), bossId: StaffId.nullable(), reason: z.string().min(1).max(2000) }).strict(),
]);

/** staff_request の入力の型 */
export type StaffRequestTool = z.infer<typeof StaffRequestTool>;
