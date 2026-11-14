import { describe, expect, it } from "vitest";
import { RESTORE_BODY_BYTES, RESTORE_TRANSCRIPT_BYTES } from "../src/index.ts";

describe("戻す会話の記録の上限", () => {
  it("上限ちょうどの記録を base64 にして JSON に入れても、/v1/restore の本文の上限に収まる", () => {
    const base64Length = Math.ceil(RESTORE_TRANSCRIPT_BYTES / 3) * 4;
    const body = JSON.stringify({ sessionId: "00000000-0000-4000-8000-000000000000", transcript: "", nextSeq: 2 ** 31 });
    expect(base64Length + body.length).toBeLessThanOrEqual(RESTORE_BODY_BYTES);
  });

  it("社員 DO が記録を戻す時に重なる大きさ (部分、つないだ物、base64、JSON) が DO のメモリ 128MB の半分に収まる", () => {
    const base64Length = Math.ceil(RESTORE_TRANSCRIPT_BYTES / 3) * 4;
    expect(RESTORE_TRANSCRIPT_BYTES * 2 + base64Length * 2).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
