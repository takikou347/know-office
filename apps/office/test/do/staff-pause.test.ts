// 止められていた時間、待っていた時間、途切れたハートビートの上限と戻り方。社員と勤怠の 3.1、3.2、3.5
import { describe, expect, it } from "vitest";
import { CALL_TASK, DAY, hire, HOUR, jst, MINUTE, rows, run, segments, startDay, TASK, totals, useD1 } from "../helpers/staff.ts";

describe("勤怠は実際の動きから付ける", () => {
  useD1();

  it("止められたまま終わりの時刻から 30 分を過ぎると退勤し、後から来た再開は何もしない", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(16));
    await s.book.stop(jst(16));
    expect(s.storage.alarm).toBe(jst(17, 30));
    await run(s, jst(17, 30), false);
    expect((await s.book.status(jst(17, 30))).state).toBe("off");
    expect(await segments()).toEqual([
      { kind: "scheduled", started_at: jst(9), ended_at: jst(16), reason: "schedule", day: DAY },
      { kind: "stopped", started_at: jst(16), ended_at: jst(17, 30), reason: "guard_stop", day: DAY },
    ]);
    expect(await totals()).toMatchObject({ clock_out: jst(17, 30), worked_ms: 7 * HOUR, stopped_ms: 90 * MINUTE });
    expect(await rows("SELECT result, active_ms FROM work_entries")).toEqual([{ result: "continued", active_ms: 7 * HOUR }]);
    // 退勤の後の再開は勤怠を変えず、翌朝は普通に出勤する
    await s.book.resume(jst(17, 40));
    expect((await s.book.status(jst(17, 40))).state).toBe("off");
    expect(s.storage.alarm).toBe(jst(33));
    s.at = jst(17, 40);
    await run(s, jst(33));
    await s.book.resume(jst(33, 1));
    expect((await s.book.status(jst(33, 1))).state).toBe("working");
    expect(await segments()).toHaveLength(2);
  });

  it("alarm が遅れて上限を過ぎてから再開が来ても、上限の時刻で退勤する", async () => {
    const stopped = hire("builder");
    await startDay(stopped);
    await run(stopped, jst(16));
    await stopped.book.stop(jst(16));
    // 17 時 30 分の alarm が鳴る前に 18 時の再開が来る
    await stopped.book.resume(jst(18));
    expect((await stopped.book.status(jst(18))).state).toBe("off");
    expect((await segments("builder")).at(-1)).toMatchObject({ kind: "stopped", started_at: jst(16), ended_at: jst(17, 30) });
    const waiting = hire("reviewer");
    await startDay(waiting);
    await run(waiting, jst(16));
    await waiting.book.waitStart("rate_limit", jst(16));
    await waiting.book.waitEnd(jst(18));
    expect((await waiting.book.status(jst(18))).state).toBe("off");
    expect((await segments("reviewer")).at(-1)).toMatchObject({ kind: "waiting", started_at: jst(16), ended_at: jst(17, 30) });
  });

  it("止められていた分だけ 30 分の期限をずらす", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(17, 10));
    await s.book.stop(jst(17, 10));
    await s.book.resume(jst(17, 20));
    s.at = jst(17, 20);
    await run(s, jst(17, 39));
    expect((await s.book.status(jst(17, 39))).state).toBe("wrapping");
    await run(s, jst(17, 40));
    expect((await s.book.status(jst(17, 40))).state).toBe("off");
    expect((await segments()).slice(1)).toEqual([
      { kind: "extension", started_at: jst(17), ended_at: jst(17, 10), reason: "checkpoint_wait", day: DAY },
      { kind: "stopped", started_at: jst(17, 10), ended_at: jst(17, 20), reason: "guard_stop", day: DAY },
      { kind: "extension", started_at: jst(17, 20), ended_at: jst(17, 40), reason: "checkpoint_wait", day: DAY },
    ]);
  });

  it("待っている間に止められると止められていた時間に切り替わり、再開した後に途切れればまた待つ", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(10));
    await run(s, jst(10, 2), false);
    expect((await s.book.status(jst(10, 2))).state).toBe("waiting");
    await s.book.stop(jst(10, 2));
    expect((await s.book.status(jst(10, 2))).state).toBe("stopped");
    // 止められている間は API の上限の待ちも受けない
    await s.book.waitStart("rate_limit", jst(10, 5));
    await s.book.resume(jst(10, 10));
    expect((await s.book.status(jst(10, 10))).state).toBe("working");
    s.at = jst(10, 10);
    await run(s, jst(10, 12), false);
    expect((await s.book.status(jst(10, 12))).state).toBe("waiting");
    await s.book.heartbeat(jst(10, 12));
    expect((await s.book.status(jst(10, 12))).state).toBe("working");
    expect((await segments()).slice(1, 4)).toEqual([
      { kind: "waiting", started_at: jst(10), ended_at: jst(10, 2), reason: "workspace_down", day: DAY },
      { kind: "stopped", started_at: jst(10, 2), ended_at: jst(10, 10), reason: "guard_stop", day: DAY },
      { kind: "waiting", started_at: jst(10, 10), ended_at: jst(10, 12), reason: "workspace_down", day: DAY },
    ]);
  });

  it("off と止められている間はハートビートを無視する", async () => {
    const s = hire();
    await s.book.heartbeat(jst(8));
    expect(await s.book.status(jst(8))).toMatchObject({ state: "off" });
    expect(s.storage.alarm).toBeNull();
    await startDay(s);
    await run(s, jst(9, 30));
    await s.book.stop(jst(9, 30));
    await s.book.heartbeat(jst(9, 31));
    expect((await s.book.status(jst(9, 31))).state).toBe("stopped");
    expect(s.storage.alarm).toBe(jst(17, 30));
    await s.book.resume(jst(9, 40));
    expect((await segments()).at(-1)).toMatchObject({ kind: "stopped", started_at: jst(9, 30), ended_at: jst(9, 40) });
  });
});

describe("ワークスペースのハートビート", () => {
  useD1();

  it("ワークスペースが戻らない間は 5 分ごとに作り直し、終わりの時刻から 30 分で退勤する", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(16, 50));
    await run(s, jst(17, 30), false);
    expect(s.workspace).toEqual(["start", ...Array.from({ length: 8 }, () => "restart"), "stop"]);
    expect((await s.book.status(jst(17, 30))).state).toBe("off");
    expect((await segments()).at(-1)).toEqual({ kind: "waiting", started_at: jst(16, 50), ended_at: jst(17, 30), reason: "workspace_down", day: DAY });
    expect(await totals()).toMatchObject({ worked_ms: 7 * HOUR + 50 * MINUTE, waiting_ms: 40 * MINUTE });
  });

  it("日をまたいだワークスペースの途切れは始まった日に入る", async () => {
    const s = hire();
    await s.book.call(CALL_TASK, jst(23, 30));
    s.at = jst(23, 30);
    await run(s, jst(23, 50));
    await run(s, jst(24, 10), false);
    await s.book.heartbeat(jst(24, 10));
    s.at = jst(24, 10);
    await run(s, jst(24, 20));
    await s.book.checkpoint({ kind: "pr", nodeId: CALL_TASK.nodeId }, jst(24, 20));
    expect(await segments()).toEqual([
      { kind: "call", started_at: jst(23, 30), ended_at: jst(23, 50), reason: "owner_instruction", day: DAY },
      { kind: "waiting", started_at: jst(23, 50), ended_at: jst(24, 10), reason: "workspace_down", day: DAY },
      { kind: "call", started_at: jst(24, 10), ended_at: jst(24, 20), reason: "owner_instruction", day: DAY },
    ]);
    expect(await totals()).toMatchObject({ call_ms: 30 * MINUTE, waiting_ms: 20 * MINUTE });
    expect(await totals("builder", "2030-01-08")).toBeUndefined();
  });
});

describe("勤怠は書き換えない", () => {
  useD1();

  it("記憶を書く前に落ちても、同じ区分を二重に書かない", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(9, 30));
    await s.book.finish("done", jst(9, 30));
    await run(s, jst(16, 59));
    const put = s.storage.put.bind(s.storage);
    // 退勤の区分を D1 に書いた後の記憶の書き込みで 1 度だけ落ちる
    s.storage.put = async (key, value) => {
      const [written] = await rows("SELECT count(*) AS n FROM attendance");
      if (written?.["n"] !== 0) {
        s.storage.put = put;
        throw new Error("記憶を書く前に落ちた");
      }
      await put(key, value);
    };
    await expect(s.book.wake(jst(17))).rejects.toThrow("記憶を書く前に落ちた");
    const again = hire("builder", s.storage);
    await again.book.wake(jst(17));
    expect((await again.book.status(jst(17))).state).toBe("off");
    expect(await segments()).toEqual([{ kind: "scheduled", started_at: jst(9), ended_at: jst(17), reason: "schedule", day: DAY }]);
    expect(await rows("SELECT node_id FROM work_entries")).toEqual([{ node_id: TASK.nodeId }]);
  });
});
