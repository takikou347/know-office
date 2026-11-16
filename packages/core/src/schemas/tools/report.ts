// 3 人のツール report の入力。オーナーへの発言 (社員が考えるの 3.6、3.8)
import { z } from "../zod.ts";

/** report の入力 */
export const ReportTool = z.object({ body: z.string().min(1).max(2000).describe("オーナーに伝える文") }).strict();

/** report の入力の型 */
export type ReportTool = z.infer<typeof ReportTool>;
