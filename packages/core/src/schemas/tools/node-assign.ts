// 社長のツール node_assign の入力。タスクを社員に割り振る (タスクとレビューの 1.2)
import { StaffId } from "../workday.ts";
import { z } from "../zod.ts";

/** node_assign の入力 */
export const NodeAssignTool = z.object({ nodeId: z.uuid(), assignee: StaffId }).strict();

/** node_assign の入力の型 */
export type NodeAssignTool = z.infer<typeof NodeAssignTool>;
