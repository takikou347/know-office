// 社員 DO を本物の workerd で起こし、StaffBook を包んだ RPC と D1 への書き込みを確かめる。社員と勤怠の 1.3
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALL_TASK, jst, MINUTE, TASK } from "../helpers/staff.ts";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

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
});
