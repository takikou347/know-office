// 社員 DO と全体のセキュリティ DO の数え方と作業トークンを、本物の workerd の RPC で確かめる (自動停止の 2 章、3.4)
import { DEFAULT_THRESHOLDS } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jst, TASK } from "../helpers/staff.ts";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

describe("止める仕組みの DO", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
  }, 30_000);
  afterEach(() => worker.dispose());

  it("社員 DO が数を持ち、止めたタスクの作業トークンを失効させる", async () => {
    await worker.staff("builder", "wake", jst(9));
    await worker.staff("builder", "take", TASK, null, jst(9));
    const { jti } = z.object({ jti: z.string() }).parse(await worker.staff("builder", "issueToken", TASK.nodeId, "ws-1", jst(9)));
    expect(await worker.staff("builder", "checkToken", jti, "ws-1", jst(9, 1))).toBe("ok");
    expect(await worker.staff("builder", "checkToken", jti, "ws-2", jst(9, 1))).toBe("misuse");
    const denied = { type: "rule_denied", staffId: "builder", nodeId: TASK.nodeId, operation: "secret.read", target: "~/.ssh" };
    expect(await worker.staff("builder", "observe", denied, jst(9, 2), DEFAULT_THRESHOLDS)).toMatchObject({ action: "stop", scope: "task", recentOps: [{ type: "rule_denied" }] });
    expect(await worker.staff("builder", "taskClock", jst(9, 3))).toEqual({ nodeId: TASK.nodeId, activeMs: 3 * 60_000 });
    await worker.staff("builder", "dropTask", TASK.nodeId, jst(9, 3));
    expect(await worker.staff("builder", "checkToken", jti, "ws-1", jst(9, 4))).toBe("revoked");
    expect(await worker.staff("builder", "taskClock", jst(9, 4))).toBeNull();
    // ほかの社員の出来事は断る
    await expect(worker.staff("reviewer", "observe", denied, jst(9, 5), DEFAULT_THRESHOLDS)).rejects.toThrow(/社員の出来事/);
  });

  it("全体のセキュリティ DO が全体の出来事を数える", async () => {
    expect(await worker.guard("observe", { type: "threshold_mismatch" }, jst(9), DEFAULT_THRESHOLDS)).toMatchObject({ action: "stop", scope: "office", signal: "certain_fraud" });
    expect(await worker.guard("keysHeld")).toBe(false);
  });

  it("同じ相手を止める権利と、同じ記録を再開する権利は 1 つだけが取れる", async () => {
    const claims = await Promise.all([worker.guard("claimStop", "staff", "builder", "s1"), worker.guard("claimStop", "staff", "builder", "s2")]);
    expect(claims.filter((c) => c === true)).toHaveLength(1);
    const winner = claims[0] === true ? "s1" : "s2";
    const releases = await Promise.all([worker.guard("releaseStop", winner), worker.guard("releaseStop", winner)]);
    expect(releases.filter((r) => r === true)).toHaveLength(1);
    // 再開の後は、同じ相手をまた止められる
    expect(await worker.guard("claimStop", "staff", "builder", "s3")).toBe(true);
  });
});
