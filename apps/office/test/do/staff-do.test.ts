// 社員 DO を本物の workerd で起こし、StaffBook を包んだ RPC と D1 への書き込みを確かめる。社員と勤怠の 1.3
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALL_TASK, DAY, jst, MINUTE, TASK } from "../helpers/staff.ts";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

/**
 * 9 時から h 時までの所定の勤務に直す値を作る
 * @param h 終わりの時
 * @returns 訂正の値
 */
function values(h: number) {
  return { kind: "scheduled", startedAt: jst(9), endedAt: jst(h), reason: "schedule", note: `${String(h)} 時までだった` };
}

describe("社員 DO", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
  }, 30_000);
  afterEach(() => worker.dispose());

  it("社員ごとの DO が出勤を D1 に書き、状態を返す", async () => {
    expect(await worker.staff("builder", "wake", jst(9))).toBeNull();
    expect(await worker.staff("builder", "take", TASK, null, jst(9))).toEqual({ taken: true });
    expect(await worker.staff("builder", "status", jst(9, 30))).toEqual({ id: "builder", state: "working", nodeId: TASK.nodeId, nodeTitle: TASK.title, workedMsToday: 30 * MINUTE });
    expect(await worker.staff("reviewer", "status", jst(9, 30))).toMatchObject({ id: "reviewer", state: "off" });
    expect(await worker.query("DB", "SELECT staff_id, clock_in FROM daily_totals")).toEqual([{ staff_id: "builder", clock_in: jst(9) }]);
  });

  it("今のタスクと違うチェックポイントを断る", async () => {
    await worker.staff("builder", "wake", jst(9));
    await expect(worker.staff("builder", "checkpoint", { kind: "commit", nodeId: CALL_TASK.nodeId }, jst(9, 1))).rejects.toThrow(/今のタスク/);
  });

  it("断った後も同じ DO が記憶を持ったまま続けて答える", async () => {
    await worker.staff("builder", "wake", jst(9));
    await worker.staff("builder", "take", TASK, null, jst(9));
    const wrong = { kind: "commit", nodeId: CALL_TASK.nodeId };
    const settled = await Promise.allSettled([
      worker.staff("builder", "checkpoint", wrong, jst(9, 0, 10)),
      worker.staff("builder", "heartbeat", jst(9, 0, 20)),
      worker.staff("builder", "checkpoint", wrong, jst(9, 0, 30)),
      worker.staff("builder", "heartbeat", jst(9, 0, 40)),
    ]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
    expect(await worker.staff("builder", "status", jst(9, 1))).toMatchObject({ state: "working", nodeId: TASK.nodeId });
  });

  it("ほかの社員の指示を断る", async () => {
    const order = { id: "0190f4a8-0000-7000-8000-0000000000a9", staffId: "reviewer", day: DAY, kind: "off", until: null, source: "button", cancels: null, createdAt: jst(8) };
    await expect(worker.staff("builder", "order", order, jst(8))).rejects.toThrow(/指示の形が違う/);
  });

  it("同じ行への訂正を並べても 1 つだけが通る", async () => {
    const id = "0190f4a8-0000-7000-8000-0000000000b2";
    await worker.query("DB", `INSERT INTO attendance (id, staff_id, day, kind, started_at, ended_at, reason, created_at) VALUES ('${id}', 'builder', '${DAY}', 'scheduled', ${String(jst(9))}, ${String(jst(17))}, 'schedule', ${String(jst(17))})`);
    const settled = await Promise.allSettled([worker.staff("builder", "correct", id, values(16), jst(18)), worker.staff("builder", "correct", id, values(15), jst(18))]);
    expect(settled.map((r) => r.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(await worker.query("DB", `SELECT count(*) AS n FROM attendance WHERE corrects = '${id}'`)).toEqual([{ n: 1 }]);
  });
});
