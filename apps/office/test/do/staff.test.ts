// 社員 DO の勤務の時刻と勤怠を、時計を進めて確かめる。社員と勤怠の 4 章。D1 は手元の本物
import { describe, expect, it } from "vitest";
import { addOrder, CALL_TASK, DAY, hire, HOUR, jst, MINUTE, rows, run, segments, startDay, TASK, testDb, totals, useD1 } from "../helpers/staff.ts";

describe("勤務の時間", () => {
  useD1();

  it("始まりの時刻が来る", async () => {
    const s = hire();
    await s.book.wake(jst(8));
    expect(s.storage.alarm).toBe(jst(9));
    await run(s, jst(9));
    expect((await s.book.status(jst(9))).state).toBe("working");
    expect(s.workspace).toEqual(["start"]);
    expect(await totals()).toMatchObject({ clock_in: jst(9), clock_out: null, worked_ms: 0 });
  });

  it("始まりと終わりの時刻は設定の最新の版に従う", async () => {
    const insert = "INSERT INTO settings (id, key, scope, value, version, changed_by, created_at) VALUES (?, 'workday.schedule', 'office', ?, ?, 'owner', 0)";
    await testDb().prepare(insert).bind("0190f4a8-0000-7000-8000-0000000000c1", JSON.stringify({ start: "08:00", end: "16:00", days: [1] }), 1).run();
    await testDb().prepare(insert).bind("0190f4a8-0000-7000-8000-0000000000c2", JSON.stringify({ start: "10:00", end: "18:00", days: [1] }), 2).run();
    const s = hire();
    await s.book.wake(jst(7));
    expect(s.storage.alarm).toBe(jst(10));
    s.at = jst(7);
    await run(s, jst(18));
    // 2030-01-07 は月曜で、次の勤務の日は次の月曜
    expect(await totals()).toMatchObject({ clock_in: jst(10), clock_out: jst(18) });
    expect(s.storage.alarm).toBe(jst(10) + 7 * 24 * HOUR);
  });
});

describe("チェックポイントで退勤する", () => {
  useD1();

  it("チェックポイントまで延ばす", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(17));
    expect((await s.book.status(jst(17))).state).toBe("wrapping");
    await run(s, jst(17, 10));
    await s.book.checkpoint({ kind: "test_pass", nodeId: TASK.nodeId }, jst(17, 10));
    expect((await s.book.status(jst(17, 10))).state).toBe("off");
    expect(await segments()).toEqual([
      { kind: "scheduled", started_at: jst(9), ended_at: jst(17), reason: "schedule", day: DAY },
      { kind: "extension", started_at: jst(17), ended_at: jst(17, 10), reason: "checkpoint_wait", day: DAY },
    ]);
    expect(await totals()).toMatchObject({ clock_in: jst(9), clock_out: jst(17, 10), worked_ms: 8 * HOUR + 10 * MINUTE, extension_ms: 10 * MINUTE });
    expect(s.workspace.at(-1)).toBe("stop");
  });

  it("30 分を超える", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(17, 30));
    expect((await s.book.status(jst(17, 30))).state).toBe("off");
    // 経過を書き残させてから止める
    expect(s.workspace.slice(-2)).toEqual(["wrapUp", "stop"]);
    expect((await segments()).at(-1)).toMatchObject({ kind: "extension", started_at: jst(17), ended_at: jst(17, 30), reason: "checkpoint_wait" });
    expect(await rows("SELECT node_id, result, started_at, ended_at, active_ms FROM work_entries")).toEqual([
      { node_id: TASK.nodeId, result: "continued", started_at: jst(9), ended_at: jst(17, 30), active_ms: 8 * HOUR + 30 * MINUTE },
    ]);
  });

  it("早く退勤する", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(16, 40));
    await s.book.finish("done", jst(16, 40));
    // 残りが 15 分を切る前なら、中央値が長くても取る
    await run(s, jst(16, 44, 59));
    expect(await s.book.take(CALL_TASK, 30 * MINUTE, jst(16, 44, 59))).toEqual({ taken: true });
    await run(s, jst(16, 45, 30));
    await s.book.finish("done", jst(16, 45, 30));
    await run(s, jst(16, 46));
    // 残り 14 分で中央値が 10 分なら取る
    expect(await s.book.take(TASK, 10 * MINUTE, jst(16, 46))).toEqual({ taken: true });
    await s.book.finish("done", jst(16, 46));
    // 残り 14 分で中央値が 20 分なら取らずに退勤する
    expect(await s.book.take(TASK, 20 * MINUTE, jst(16, 46))).toEqual({ taken: false });
    expect((await s.book.status(jst(16, 46))).state).toBe("off");
    expect(await segments()).toEqual([{ kind: "scheduled", started_at: jst(9), ended_at: jst(16, 46), reason: "schedule", day: DAY }]);
    expect(await totals()).toMatchObject({ clock_out: jst(16, 46), reasons: JSON.stringify(["leave_early:schedule"]) });
    // 同じ日の残りの時刻にもう一度出勤しない
    await run(s, jst(17));
    expect((await s.book.status(jst(17))).state).toBe("off");
    expect(s.storage.alarm).toBe(jst(9) + 24 * HOUR);
  });
});

describe("オーナーの指示に合わせる", () => {
  useD1();

  it("時間外の呼び出し", async () => {
    const builder = hire("builder");
    const reviewer = hire("reviewer");
    await builder.book.wake(jst(21));
    await reviewer.book.wake(jst(21));
    await builder.book.call(CALL_TASK, jst(21));
    builder.at = jst(21);
    expect(await builder.book.status(jst(21))).toMatchObject({ state: "called", nodeId: CALL_TASK.nodeId, nodeTitle: CALL_TASK.title });
    expect((await reviewer.book.status(jst(21))).state).toBe("off");
    await run(builder, jst(21, 40));
    await builder.book.checkpoint({ kind: "pr", nodeId: CALL_TASK.nodeId }, jst(21, 40));
    expect((await builder.book.status(jst(21, 40))).state).toBe("off");
    expect(await segments("builder")).toEqual([{ kind: "call", started_at: jst(21), ended_at: jst(21, 40), reason: "owner_instruction", day: DAY }]);
    expect(await segments("reviewer")).toEqual([]);
    expect(await totals()).toMatchObject({ worked_ms: 40 * MINUTE, call_ms: 40 * MINUTE, reasons: JSON.stringify(["call:owner_instruction"]) });
    expect(builder.workspace).toEqual(["start", "stop"]);
    expect(reviewer.workspace).toEqual([]);
  });

  it("呼び出しは 2 時間で経過を書き残して退勤する", async () => {
    const s = hire();
    await s.book.call(CALL_TASK, jst(21));
    s.at = jst(21);
    await run(s, jst(23));
    expect((await s.book.status(jst(23))).state).toBe("off");
    expect(s.workspace).toEqual(["start", "wrapUp", "stop"]);
    expect(await rows("SELECT result FROM work_entries")).toEqual([{ result: "continued" }]);
  });

  it("その日だけ休みにする", async () => {
    const s = hire();
    const order = await addOrder({ id: "0190f4a8-0000-7000-8000-0000000000a1", kind: "off", until: null, source: "button", createdAt: jst(8) });
    await s.book.order(order, jst(8));
    await run(s, jst(17));
    expect((await s.book.status(jst(17))).state).toBe("off");
    expect(await s.book.take(TASK, null, jst(17))).toEqual({ taken: false });
    expect(s.workspace).toEqual([]);
    expect(await segments()).toEqual([]);
    expect(await totals()).toMatchObject({ clock_in: null, worked_ms: 0, reasons: JSON.stringify(["off:owner_instruction"]) });
  });

  it("勤務中の休みの指示はチェックポイントで退勤する", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(11));
    const order = await addOrder({ id: "0190f4a8-0000-7000-8000-0000000000a2", kind: "off", until: null, source: "chat", createdAt: jst(11) });
    await s.book.order(order, jst(11));
    expect((await s.book.status(jst(11))).state).toBe("wrapping");
    await run(s, jst(11, 5));
    await s.book.checkpoint({ kind: "commit", nodeId: TASK.nodeId }, jst(11, 5));
    expect((await s.book.status(jst(11, 5))).state).toBe("off");
    expect((await totals())?.["reasons"]).toBe(JSON.stringify(["extension:checkpoint_wait", "off:owner_instruction"]));
  });
});

describe("勤怠は実際の動きから付ける", () => {
  useD1();

  it("セキュリティに止められていた時間", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(10));
    await s.book.stop(jst(10));
    expect((await s.book.status(jst(10))).state).toBe("stopped");
    // 止められている間はハートビートが来ない
    await run(s, jst(10, 20), false);
    await s.book.resume(jst(10, 20));
    s.at = jst(10, 20);
    await run(s, jst(16));
    await s.book.finish("done", jst(16));
    await run(s, jst(17));
    expect(await segments()).toEqual([
      { kind: "scheduled", started_at: jst(9), ended_at: jst(10), reason: "schedule", day: DAY },
      { kind: "stopped", started_at: jst(10), ended_at: jst(10, 20), reason: "guard_stop", day: DAY },
      { kind: "scheduled", started_at: jst(10, 20), ended_at: jst(17), reason: "schedule", day: DAY },
    ]);
    expect(await totals()).toMatchObject({ worked_ms: 8 * HOUR - 20 * MINUTE, stopped_ms: 20 * MINUTE });
    // タスクの掛かった時間に止められていた時間を入れない
    expect(await rows("SELECT active_ms, result FROM work_entries")).toEqual([{ active_ms: 7 * HOUR - 20 * MINUTE, result: "done" }]);
  });

  it("API の上限を待つ", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(11));
    await s.book.waitStart("rate_limit", jst(11));
    expect((await s.book.status(jst(11))).state).toBe("waiting");
    await run(s, jst(11, 15));
    await s.book.waitEnd(jst(11, 15));
    expect((await s.book.status(jst(11, 15))).state).toBe("working");
    await run(s, jst(12));
    await s.book.finish("done", jst(12));
    await run(s, jst(17));
    expect((await segments())[1]).toEqual({ kind: "waiting", started_at: jst(11), ended_at: jst(11, 15), reason: "rate_limit", day: DAY });
    expect(await totals()).toMatchObject({ worked_ms: 8 * HOUR - 15 * MINUTE, waiting_ms: 15 * MINUTE });
  });

  it("働いた時間の集計", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(17, 10));
    await s.book.checkpoint({ kind: "commit", nodeId: TASK.nodeId }, jst(17, 10));
    // 23 時 30 分の呼び出しは日をまたいでも始まった日に入る
    await s.book.call(CALL_TASK, jst(23, 30));
    s.at = jst(23, 30);
    await run(s, jst(24, 20));
    await s.book.checkpoint({ kind: "pr", nodeId: CALL_TASK.nodeId }, jst(24, 20));
    expect((await segments()).at(-1)).toEqual({ kind: "call", started_at: jst(23, 30), ended_at: jst(24, 20), reason: "owner_instruction", day: DAY });
    expect(await totals()).toMatchObject({
      clock_in: jst(9),
      clock_out: jst(24, 20),
      worked_ms: 8 * HOUR + 10 * MINUTE + 50 * MINUTE,
      extension_ms: 10 * MINUTE,
      call_ms: 50 * MINUTE,
      stopped_ms: 0,
      waiting_ms: 0,
    });
    expect(await totals("builder", "2030-01-08")).toBeUndefined();
    // 次の日も 9 時に出勤する
    await run(s, jst(33));
    expect((await s.book.status(jst(33))).state).toBe("working");
    expect(await s.book.status(jst(33))).toMatchObject({ workedMsToday: 0 });
  });

  it("今日の働いた時間を返す", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(10));
    await s.book.stop(jst(10));
    await s.book.resume(jst(10, 30));
    expect(await s.book.status(jst(11))).toMatchObject({ state: "working", nodeId: TASK.nodeId, workedMsToday: 90 * MINUTE });
  });
});

describe("理由を残す", () => {
  useD1();

  it("延長の理由", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(10));
    const order = await addOrder({ id: "0190f4a8-0000-7000-8000-0000000000a3", kind: "extend", until: jst(18), source: "button", createdAt: jst(10) });
    await s.book.order(order, jst(10));
    await run(s, jst(18, 5));
    await s.book.checkpoint({ kind: "note", nodeId: TASK.nodeId, note: "続きは明日" }, jst(18, 5));
    expect(await segments()).toEqual([
      { kind: "scheduled", started_at: jst(9), ended_at: jst(17), reason: "schedule", day: DAY },
      { kind: "extension", started_at: jst(17), ended_at: jst(18), reason: "owner_instruction", day: DAY },
      { kind: "extension", started_at: jst(18), ended_at: jst(18, 5), reason: "checkpoint_wait", day: DAY },
    ]);
    expect(await totals()).toMatchObject({ extension_ms: 65 * MINUTE, reasons: JSON.stringify(["extension:checkpoint_wait", "extension:owner_instruction"]) });
  });
});

describe("ワークスペースのハートビート", () => {
  useD1();

  it("ワークスペースが落ちる", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(10));
    // 10 時 00 分から 05 分までハートビートが来ない
    await run(s, jst(10, 5), false);
    expect((await s.book.status(jst(10, 5))).state).toBe("waiting");
    expect(s.workspace).toEqual(["start", "restart"]);
    await s.book.heartbeat(jst(10, 5));
    expect((await s.book.status(jst(10, 5))).state).toBe("working");
    await run(s, jst(12));
    await s.book.finish("done", jst(12));
    await run(s, jst(17));
    expect(await segments()).toEqual([
      { kind: "scheduled", started_at: jst(9), ended_at: jst(10), reason: "schedule", day: DAY },
      { kind: "waiting", started_at: jst(10), ended_at: jst(10, 5), reason: "workspace_down", day: DAY },
      { kind: "scheduled", started_at: jst(10, 5), ended_at: jst(17), reason: "schedule", day: DAY },
    ]);
    expect(await totals()).toMatchObject({ worked_ms: 8 * HOUR - 5 * MINUTE, waiting_ms: 5 * MINUTE, reasons: JSON.stringify(["waiting:workspace_down"]) });
  });

  it("起き直した時に 90 秒を過ぎていれば、最後のハートビートの時刻で閉じる", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(10));
    // 同じ記憶で DO が起き直し、10 時 3 分に初めて alarm が鳴る
    const again = hire("builder", s.storage);
    await again.book.wake(jst(10, 3));
    expect((await again.book.status(jst(10, 3))).state).toBe("waiting");
    await again.book.heartbeat(jst(10, 4));
    await again.book.finish("done", jst(10, 4));
    again.at = jst(10, 4);
    await run(again, jst(17));
    expect((await segments())[1]).toMatchObject({ kind: "waiting", started_at: jst(10), ended_at: jst(10, 4) });
  });
});
