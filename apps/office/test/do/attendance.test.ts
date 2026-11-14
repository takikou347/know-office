// 勤怠の訂正。元の行を残し、訂正の行を足して集計を作り直す。社員と勤怠の 3.6
import { describe, expect, it } from "vitest";
import { DAY, hire, type Hired, HOUR, jst, MINUTE, rows, run, startDay, TASK, testDb, totals, useD1 } from "../helpers/staff.ts";

/**
 * 17 時 10 分のチェックポイントで退勤した日を作る
 * @returns 社員
 */
async function extensionDay(): Promise<Hired> {
  const s = hire();
  await startDay(s);
  await run(s, jst(17, 10));
  await s.book.checkpoint({ kind: "commit", nodeId: TASK.nodeId }, jst(17, 10));
  return s;
}

/**
 * 延長の行の ID を読む
 * @returns ID
 */
async function extensionId(): Promise<string> {
  const [row] = await rows("SELECT id FROM attendance WHERE kind = 'extension' AND corrects IS NULL");
  return String(row?.["id"]);
}

describe("勤怠は書き換えない", () => {
  useD1();

  it("誤りを直す", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(17, 10));
    await s.book.checkpoint({ kind: "commit", nodeId: TASK.nodeId }, jst(17, 10));
    const [extension] = await rows("SELECT id FROM attendance WHERE kind = 'extension'");
    const original = String(extension?.["id"]);
    await s.book.correct(original, { kind: "extension", startedAt: jst(17), endedAt: jst(17, 25), reason: "checkpoint_wait", note: "チェックの終わりを取り違えた" }, jst(18));
    const all = await rows("SELECT id, kind, ended_at, corrects FROM attendance ORDER BY created_at");
    expect(all).toHaveLength(3);
    expect(all).toContainEqual({ id: original, kind: "extension", ended_at: jst(17, 10), corrects: null });
    expect(all.at(-1)).toMatchObject({ kind: "extension", ended_at: jst(17, 25), corrects: original });
    expect(await totals()).toMatchObject({ clock_out: jst(17, 25), worked_ms: 8 * HOUR + 25 * MINUTE, extension_ms: 25 * MINUTE });
  });

  it("訂正が別の区分と重なれば断る", async () => {
    const s = hire();
    await startDay(s);
    await run(s, jst(12));
    await s.book.finish("done", jst(12));
    await run(s, jst(17));
    const [scheduled] = await rows("SELECT id FROM attendance");
    await testDb().prepare("INSERT INTO attendance (id, staff_id, day, kind, started_at, ended_at, reason, created_at) VALUES ('0190f4a8-0000-7000-8000-0000000000b1', 'builder', ?, 'call', ?, ?, 'owner_instruction', ?)")
      .bind(DAY, jst(18), jst(19), jst(19))
      .run();
    await expect(
      s.book.correct(String(scheduled?.["id"]), { kind: "scheduled", startedAt: jst(9), endedAt: jst(18, 30), reason: "schedule", note: "重なる" }, jst(20)),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(s.book.correct("0190f4a8-0000-7000-8000-0000000000ff", { kind: "scheduled", startedAt: jst(9), endedAt: jst(10), reason: "schedule", note: "無い" }, jst(20))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("訂正された行は訂正し直せない", async () => {
    const s = await extensionDay();
    const original = await extensionId();
    const values = { kind: "extension", startedAt: jst(17), endedAt: jst(17, 25), reason: "checkpoint_wait", note: "1 度目" };
    await s.book.correct(original, values, jst(18));
    await expect(s.book.correct(original, { ...values, endedAt: jst(17, 20), note: "2 度目" }, jst(19))).rejects.toMatchObject({ code: "conflict" });
    expect(await rows("SELECT id FROM attendance WHERE corrects IS NOT NULL")).toHaveLength(1);
  });

  it("集計の理由は効いている行から作り直す", async () => {
    const s = await extensionDay();
    // 行に出ない早い退勤の理由と、もう効いていない古い理由を集計に置いておく
    await testDb()
      .prepare("UPDATE daily_totals SET reasons = ? WHERE staff_id = 'builder' AND day = ?")
      .bind(JSON.stringify(["extension:checkpoint_wait", "leave_early:schedule", "stopped:guard_stop"]), DAY)
      .run();
    await s.book.correct(await extensionId(), { kind: "extension", startedAt: jst(17), endedAt: jst(17, 10), reason: "owner_instruction", note: "延長はオーナーの指示だった" }, jst(18));
    expect((await totals())?.["reasons"]).toBe(JSON.stringify(["extension:owner_instruction", "leave_early:schedule"]));
  });

  it("ほかの社員の行は訂正できない", async () => {
    await extensionDay();
    const reviewer = hire("reviewer");
    const values = { kind: "extension", startedAt: jst(17), endedAt: jst(17, 5), reason: "checkpoint_wait", note: "違う社員" };
    await expect(reviewer.book.correct(await extensionId(), values, jst(18))).rejects.toMatchObject({ code: "not_found" });
  });
});
