// DO のテストの入口の手伝いが、2 回目からも前のテストの DO の記憶、D1、R2、エラーログを残さず渡す事を確かめる
import { toBase64 } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { TASK, jst } from "../helpers/staff.ts";
import { startTestWorker } from "../helpers/worker.ts";

const start = Date.UTC(2026, 10, 14, 3, 0, 0);
const MINUTE = 60_000;
const SESSION = "0190f4a8-0000-7000-8000-00000000c001";

describe("DO のテストの入口", () => {
  it("2 回目に渡す入口は、前のテストの DO の記憶、ワークスペースの呼び出し、D1、R2、エラーログを持たない", async () => {
    const first = await startTestWorker();
    // 全体のセキュリティ DO を 5 回の失敗でロックアウトさせ、通知を D1 に書かせる
    for (let n = 0; n < 5; n += 1) await first.guard("fail", "203.0.113.1", start + n * MINUTE);
    expect(await first.guard("admit", "203.0.113.1", "api", start + 5 * MINUTE)).toEqual({ locked: true, retryAfter: null });
    // 社員 DO に出勤させ、タスクを持たせ、会話の記録を R2 に置かせる
    await first.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, task_kind, created_by, created_at, updated_at) VALUES ('${TASK.nodeId}', 'task', NULL, 'office', '${TASK.title}', 'doing', 1, 'builder', 'build', 'president', 0, 0)`,
    );
    await first.staff("builder", "wake", jst(9));
    await first.staff("builder", "take", TASK, null, jst(9));
    await first.staff("builder", "heartbeat", jst(9, 1));
    await first.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 0, chunk: toBase64(new TextEncoder().encode("{}\n")) }, jst(9, 2));
    expect(await first.files("")).not.toEqual([]);
    // ワークスペースが中断に答えない形にしてタスクを外させ、エラーログを残させる
    await first.workspaceMode("builder", "abort_down");
    await first.query("DB", `UPDATE nodes SET status = 'stopped' WHERE id = '${TASK.nodeId}'`);
    await first.staff("builder", "dropTask", TASK.nodeId, jst(9, 3));
    for (let n = 0; n < 100 && (await first.errorLogs()).length === 0; n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await first.errorLogs()).not.toEqual([]);
    // 記録 DO は最後のハッシュをフィールドに持つ
    await first.call("append", { at: start, actor: "system", action: "test.append", target: "1", scope: "office", detail: null });

    const second = await startTestWorker();
    expect(await second.guard("admit", "203.0.113.1", "api", start + 5 * MINUTE)).toEqual({ locked: false, retryAfter: null });
    expect(await second.staff("builder", "status", jst(9, 30))).toMatchObject({ id: "builder", state: "off" });
    expect(await second.query("DB", "SELECT kind FROM notices")).toEqual([]);
    expect(await second.query("DB", "SELECT staff_id FROM daily_totals")).toEqual([]);
    expect(await second.query("DB", "SELECT id FROM nodes")).toEqual([]);
    expect(await second.files("")).toEqual([]);
    expect(await second.workspace("builder")).toEqual([]);
    expect(await second.errorLogs()).toEqual([]);
    // 作り直した記録 DO は、空の D1 の頭からチェーンを始める
    await second.call("append", { at: start, actor: "system", action: "test.append", target: "2", scope: "office", detail: null });
    expect(await second.call("verify", 2026)).toMatchObject({ ok: true, brokenAt: null });
  });
});
