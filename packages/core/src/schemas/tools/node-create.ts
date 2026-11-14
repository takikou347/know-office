// 社長のツール node_create の入力。目標の下にプロジェクトを、プロジェクトの下にタスクを作る (タスクとレビューの 1.2)
import { StaffId } from "../workday.ts";
import { z } from "../zod.ts";

/** node_create の入力。repo はタスクを直すリポジトリ (`<owner>/<name>`) */
export const NodeCreateTool = z
  .object({
    kind: z.enum(["project", "task"]),
    parentId: z.uuid(),
    title: z.string().min(1).max(200),
    body: z.string().max(20_000).optional(),
    taskKind: z.enum(["build", "content", "fix"]).optional(),
    assignee: StaffId.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
      .optional(),
  })
  .strict();

/** node_create の入力の型 */
export type NodeCreateTool = z.infer<typeof NodeCreateTool>;
