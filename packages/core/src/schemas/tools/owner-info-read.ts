// 3 人のツール owner_info_read の入力。ルールで許したオーナーの情報の 1 項目を読む (社員が考えるの 3.4、3.5)
import { z } from "../zod.ts";

/** オーナーの情報の項目の名前。`<拡張 ID>.<項目>` で、拡張 ID と項目は拡張のツールの名前と同じ文字だけ */
export const OWNER_INFO_ITEM = /^([a-z][a-z\d-]{0,39})\.([a-z][a-z\d_]{0,39})$/;

/** owner_info_read の入力 */
export const OwnerInfoReadTool = z.object({ item: z.string().regex(OWNER_INFO_ITEM).describe("読む項目。<拡張 ID>.<項目> の形") }).strict();

/** owner_info_read の入力の型 */
export type OwnerInfoReadTool = z.infer<typeof OwnerInfoReadTool>;
