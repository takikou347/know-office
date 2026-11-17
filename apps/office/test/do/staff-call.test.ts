// 時間外の話しかけで社員を呼び出す時の、社員 DO の判断。社員ごとに日本時間の日ごとの回数を数える (社員と勤怠の 3.4)
import { describe, expect, it } from "vitest";
import { EMPTY_MEMORY } from "../../src/gate/work/shift.ts";
import { CALL_TASK, hire, jst, MINUTE, TASK, useD1 } from "../helpers/staff.ts";

describe("オーナーの指示に合わせる", () => {
  useD1();

  it("時間外の話しかけで呼び出す", async () => {
    const s = hire();
    expect(await s.book.call(CALL_TASK, jst(21), { perDay: 2 })).toBe(true);
    s.at = jst(21);
    expect(await s.book.status(jst(21))).toMatchObject({ state: "called", nodeId: CALL_TASK.nodeId });
    // 勤務の中の社員は呼び出さず、タスクを戻させる
    const working = hire("reviewer");
    await working.book.wake(jst(9));
    expect(await working.book.call(TASK, jst(10), { perDay: 2 })).toBe(false);
  });

  it("1 日の回数で呼び出さない", async () => {
    const s = hire();
    const callAndLeave = async (at: number): Promise<boolean> => {
      const called = await s.book.call(CALL_TASK, at, { perDay: 2 });
      if (called) {
        s.at = at;
        await s.book.checkpoint({ kind: "pr", nodeId: CALL_TASK.nodeId }, at + MINUTE);
      }
      return called;
    };
    // タスクを頼んだ時の呼び出しは数えない
    await s.book.call(CALL_TASK, jst(18));
    await s.book.checkpoint({ kind: "pr", nodeId: CALL_TASK.nodeId }, jst(18, 1));
    expect(await callAndLeave(jst(19))).toBe(true);
    expect(await callAndLeave(jst(20))).toBe(true);
    expect(await callAndLeave(jst(21))).toBe(false);
    expect((await s.book.status(jst(21))).state).toBe("off");
    // 日本時間の次の日は数え直す
    expect(await callAndLeave(jst(24, 30))).toBe(true);
    // 1 回の日は 2 回目から呼び出さない
    const once = hire("reviewer");
    expect(await once.book.call(CALL_TASK, jst(19), { perDay: 1 })).toBe(true);
    await once.book.checkpoint({ kind: "pr", nodeId: CALL_TASK.nodeId }, jst(19, 1));
    expect(await once.book.call(CALL_TASK, jst(20), { perDay: 1 })).toBe(false);
    // 回数を持つ前に書いた記憶も読める
    const old = hire("president");
    const { talkCalls: _drop, ...before } = EMPTY_MEMORY;
    await old.storage.put("memory", before);
    expect(await old.book.call(CALL_TASK, jst(21), { perDay: 1 })).toBe(true);
  });
});
