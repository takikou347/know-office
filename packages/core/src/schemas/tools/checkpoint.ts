// 3 人のツール checkpoint の入力。テストが通る、コミット、プルリクエスト、経過を書き残す所に届いた事を伝える (社員が考えるの 3.5)
import { z } from "../zod.ts";

/** checkpoint の入力。タスクは作業トークンのタスクで、入力からは決めない */
export const CheckpointTool = z
  .object({
    kind: z.enum(["test_pass", "commit", "pr", "note"]).describe("test_pass はテストが通った、commit はコミットした、pr はプルリクエストを出した、note は経過を書き残した"),
    note: z.string().max(2000).optional().describe("経過の短い説明"),
  })
  .strict();

/** checkpoint の入力の型 */
export type CheckpointTool = z.infer<typeof CheckpointTool>;
