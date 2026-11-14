// 社長のツール study_submit の入力。検討の段階の案を調べた材料を出す (サービスと拡張の 3.1 の 2)
import { z } from "../zod.ts";

/** study_submit の入力。body は似た物、作る量、セキュリティの要る所を書いた Markdown */
export const StudySubmitTool = z.object({ serviceId: z.uuid(), body: z.string().min(1).max(20_000) }).strict();

/** study_submit の入力の型 */
export type StudySubmitTool = z.infer<typeof StudySubmitTool>;
