// 退勤で次の勤務へ続けたタスクを、した仕事の行と同じバッチで todo に戻し、同時の変更と途中で落ちた時に片方だけ残さない事を確かめる。社員と勤怠の 3.3。D1 は手元の本物
import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { StaffBook } from "../../src/gate/work/staff-book.ts";
import { type Hired, hire, jst, rows, run, startDay, TASK, testDb, useD1 } from "../helpers/staff.ts";

const noop = () => Promise.resolve();

/** 開発担当が持つ doing のタスクを置く */
async function heldTask(): Promise<void> {
  await testDb()
    .prepare("INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, task_kind, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', ?, 'doing', 1, 'builder', 'build', 'president', 0, 0)")
    .bind(TASK.nodeId, TASK.title)
    .run();
}

/**
 * D1 のまとめた書き込みの前後に別の動きを挟む本を、同じ記憶で作る
 * @param s 社員
 * @param around 書き込みを包む。write を呼ぶと本物の D1 に書く
 * @returns 本
 */
function bookAround(s: Hired, around: (write: () => Promise<unknown>) => Promise<unknown>): StaffBook {
  const db = new Proxy(testDb(), {
    get: (target, key) => (key === "batch" ? (statements: Parameters<D1Database["batch"]>[0]) => around(() => target.batch(statements)) : (Reflect.get(target, key, target) as unknown)),
  });
  return new StaffBook("builder", s.storage, db, { start: noop, stop: noop, wrapUp: noop, abort: noop, restart: noop });
}

/**
 * タスクの状態、版、担当を読む
 * @returns 行
 */
async function node(): Promise<Record<string, unknown> | undefined> {
  return (await rows(`SELECT status, version, assignee FROM nodes WHERE id = '${TASK.nodeId}'`))[0];
}

/**
 * 出勤してタスクを取り、30 分の延長が切れる直前まで進める
 * @returns 社員
 */
async function wrappingUp(): Promise<Hired> {
  await heldTask();
  const s = hire();
  await startDay(s);
  await run(s, jst(17, 29));
  return s;
}

describe("退勤で続きにしたタスク (3.3)", () => {
  useD1();

  it("30 分を超えて続きにしたタスクは、した仕事の行と同じ時に todo に戻す", async () => {
    const s = await wrappingUp();
    await run(s, jst(17, 30));
    expect((await s.book.status(jst(17, 30))).nodeId).toBeNull();
    expect(await node()).toEqual({ status: "todo", version: 2, assignee: "builder" });
    expect(await rows("SELECT node_id, result FROM work_entries")).toEqual([{ node_id: TASK.nodeId, result: "continued" }]);
  });

  it("退勤を書く直前にオーナーがタスクを止めていたら、止めたままにする", async () => {
    const s = await wrappingUp();
    const racing = bookAround(s, async (write) => {
      await testDb().prepare("UPDATE nodes SET status = 'stopped', version = version + 1 WHERE id = ?").bind(TASK.nodeId).run();
      return write();
    });
    await racing.wake(jst(17, 30));
    expect(await node()).toEqual({ status: "stopped", version: 2, assignee: "builder" });
    expect(await rows("SELECT result FROM work_entries")).toEqual([{ result: "continued" }]);
  });

  it("担当がほかの社員に変わったタスクは、続きにしても戻さない", async () => {
    const s = await wrappingUp();
    await testDb().prepare("UPDATE nodes SET assignee = 'reviewer', version = version + 1 WHERE id = ?").bind(TASK.nodeId).run();
    await run(s, jst(17, 30));
    expect(await node()).toEqual({ status: "doing", version: 2, assignee: "reviewer" });
  });

  it("退勤を D1 に書く前に落ちても、起き直した時にタスクを 1 度だけ todo に戻す", async () => {
    const s = await wrappingUp();
    const crashing = bookAround(s, () => Promise.reject(new Error("D1 に書く前に落ちた")));
    await expect(crashing.wake(jst(17, 30))).rejects.toThrow("D1 に書く前に落ちた");
    // 落ちた時は D1 も変わらない
    expect(await node()).toEqual({ status: "doing", version: 1, assignee: "builder" });
    expect(await rows("SELECT result FROM work_entries")).toEqual([]);
    const again = hire("builder", s.storage);
    expect(await again.book.status(jst(17, 31))).toMatchObject({ state: "off", nodeId: null });
    await again.book.wake(jst(17, 32));
    expect(await node()).toEqual({ status: "todo", version: 2, assignee: "builder" });
    expect(await rows("SELECT result FROM work_entries")).toEqual([{ result: "continued" }]);
  });

  it("退勤を D1 に書いた後に落ち、起き直す前にタスクがまた取られていても、todo に戻し直さない", async () => {
    const s = await wrappingUp();
    const crashing = bookAround(s, async (write) => {
      await write();
      throw new Error("D1 に書いた後に落ちた");
    });
    await expect(crashing.wake(jst(17, 30))).rejects.toThrow("D1 に書いた後に落ちた");
    expect(await node()).toEqual({ status: "todo", version: 2, assignee: "builder" });
    // 起き直す前に、ほかの道がタスクをもう一度 doing にする
    await testDb().prepare("UPDATE nodes SET status = 'doing', version = version + 1 WHERE id = ?").bind(TASK.nodeId).run();
    const again = hire("builder", s.storage);
    await again.book.wake(jst(17, 31));
    expect(await node()).toEqual({ status: "doing", version: 3, assignee: "builder" });
    expect(await rows("SELECT result FROM work_entries")).toEqual([{ result: "continued" }]);
  });
});
