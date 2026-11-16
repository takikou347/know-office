// 退勤で次の勤務へ続けたタスクを、した仕事の行と同じバッチで todo に戻し、同時の変更と途中で落ちた時に片方だけ残さない事を確かめる。社員と勤怠の 3.3。D1 は手元の本物
import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import type { CarriedTask } from "../../src/gate/work/carry.ts";
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
 * @param carried 続けたタスクの出来事を書く
 * @returns 本
 */
function bookAround(s: Hired, around: (write: () => Promise<unknown>) => Promise<unknown>, carried: (row: CarriedTask) => Promise<void> = noop): StaffBook {
  const db = new Proxy(testDb(), {
    get: (target, key) => (key === "batch" ? (statements: Parameters<D1Database["batch"]>[0]) => around(() => target.batch(statements)) : (Reflect.get(target, key, target) as unknown)),
  });
  return new StaffBook("builder", s.storage, db, { start: noop, stop: noop, wrapUp: noop, abort: noop, restart: noop }, noop, carried);
}

/** 出来事の書き手の代わり。down の間は記録の D1 が落ちた形で投げ、書けた物を並べる */
type EventSink = { down: boolean; written: CarriedTask[]; write: (row: CarriedTask) => Promise<void> };

/**
 * 出来事の書き手の代わりを作る
 * @param down 初めから落ちているか
 * @returns 書き手
 */
function eventSink(down = false): EventSink {
  const sink: EventSink = {
    down,
    written: [],
    write: (row) => {
      if (sink.down) return Promise.reject(new Error("記録の D1 が無い"));
      sink.written.push(row);
      return Promise.resolve();
    },
  };
  return sink;
}

const passThrough = (write: () => Promise<unknown>) => write();

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

  it("記録の D1 に出来事を書けない間も、退勤が終わり、ほかの操作が通り、戻った後に出来事を 1 件だけ残す", async () => {
    const s = await wrappingUp();
    const sink = eventSink(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const book = bookAround(s, passThrough, sink.write);
      await book.wake(jst(17, 30));
      expect(await book.status(jst(17, 31))).toMatchObject({ state: "off", nodeId: null });
      expect(await node()).toEqual({ status: "todo", version: 2, assignee: "builder" });
      // 落ちている間も、ほかの操作は断られない
      await book.heartbeat(jst(17, 31));
      await book.wake(jst(17, 32));
      expect(sink.written).toEqual([]);
      expect(warn.mock.calls.some(([line]) => String(line).includes('"event":"staff_event_failed"'))).toBe(true);
      // 戻った後の次の操作で書き直し、その後は書かない
      sink.down = false;
      await book.wake(jst(17, 33));
      await book.wake(jst(17, 34));
      await bookAround(s, passThrough, sink.write).status(jst(17, 35));
      expect(sink.written.map((e) => ({ nodeId: e.nodeId, at: e.at }))).toEqual([{ nodeId: TASK.nodeId, at: jst(17, 30) }]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["オーナーが止めた", "status = 'stopped'"],
    ["担当がほかの社員に変わった", "assignee = 'reviewer'"],
  ])("%s ために todo に戻せなかったタスクは、続けた出来事を残さない", async (_, change) => {
    const s = await wrappingUp();
    const sink = eventSink();
    const racing = bookAround(
      s,
      async (write) => {
        await testDb().prepare(`UPDATE nodes SET ${change}, version = version + 1 WHERE id = ?`).bind(TASK.nodeId).run();
        return write();
      },
      sink.write,
    );
    await racing.wake(jst(17, 30));
    expect(sink.written).toEqual([]);
  });

  it("D1 に書いた後に落ちても、起き直した時に続けた出来事を 1 件だけ残す", async () => {
    const s = await wrappingUp();
    const sink = eventSink();
    const crashing = bookAround(
      s,
      async (write) => {
        await write();
        throw new Error("D1 に書いた後に落ちた");
      },
      sink.write,
    );
    await expect(crashing.wake(jst(17, 30))).rejects.toThrow("D1 に書いた後に落ちた");
    const again = bookAround(s, passThrough, sink.write);
    await again.wake(jst(17, 31));
    await again.wake(jst(17, 32));
    expect(sink.written.map((e) => ({ nodeId: e.nodeId, at: e.at }))).toEqual([{ nodeId: TASK.nodeId, at: jst(17, 30) }]);
  });
});
