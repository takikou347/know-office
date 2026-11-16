// 見本の拡張。オーナーが社員に残すメモを 1 つ置き、社員は note_read で読む (サービスと拡張の 3.8)
import { defineExtension } from "../../gate/extensions/define.ts";
import { NoteReadTool, SampleNote, UpdateSampleNoteInput } from "./schema.ts";

/** メモが無い時に返す物 */
const EMPTY: SampleNote = { body: "" };

/**
 * 置いたメモを読む
 * @param store 拡張の置き場
 * @param store.get 置いた値を読む
 * @returns メモ。無いか形が違えば空のメモ
 */
async function readNote(store: { get(key: string): Promise<unknown> }): Promise<SampleNote> {
  return SampleNote.safeParse(await store.get("note")).data ?? EMPTY;
}

export default defineExtension({
  id: "sample-notes",
  title: "メモ",
  ownerData: false,
  routes: [
    { method: "get", path: "/note", operationId: "getSampleNote", summary: "見本の拡張機能のメモを読む", steps: ["R2 の `ext/sample-notes/note.json` を読む。無ければ空のメモを返す"], response: SampleNote, run: (ctx) => readNote(ctx.store) },
    {
      method: "put",
      path: "/note",
      operationId: "updateSampleNote",
      summary: "見本の拡張機能のメモを置き換える",
      steps: ["R2 の `ext/sample-notes/note.json` を置き換え、監査ログに `extension.write` を記録する"],
      body: UpdateSampleNoteInput,
      response: SampleNote,
      run: async (ctx, body: UpdateSampleNoteInput) => {
        await ctx.store.put("note", body);
        return body;
      },
    },
  ],
  tools: {
    note_read: { description: "オーナーが社員に残したメモを読む", schema: NoteReadTool, run: (ctx) => readNote(ctx.store) },
  },
});
