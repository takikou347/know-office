// 見本の拡張のメモの形。ゲートウェイと画面が共に使う
import { z } from "zod";

/** メモ。本文は 2,000 字まで */
export const SampleNote = z.object({ body: z.string().max(2000) }).strict().meta({ id: "SampleNote" });

/** メモの型 */
export type SampleNote = z.infer<typeof SampleNote>;

/** メモを置き換える入力 */
export const UpdateSampleNoteInput = z.object({ body: z.string().max(2000) }).strict().meta({ id: "UpdateSampleNoteInput" });

/** note_read の入力。何も受けない */
export const NoteReadTool = z.object({}).strict();

/** メモを置き換える入力の型 */
export type UpdateSampleNoteInput = z.infer<typeof UpdateSampleNoteInput>;
