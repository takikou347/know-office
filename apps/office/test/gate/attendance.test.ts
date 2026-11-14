// 勤怠のルートと 0 時 5 分のジョブ。1 日の勤怠を本物の記録から返し、訂正を 409 まで problem+json で返す (社員と勤怠の 3.6 と 3.7、ルートの一覧の 1.3 と 1.4)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DAILY_CRON, runDaily } from "../../src/gate/jobs/daily.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";
import { DAY, HOUR, jst, MINUTE } from "../helpers/staff.ts";

let clock: ReturnType<typeof fixedClock>;
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
// テストごとに空の D1 とゲートウェイを作る。時計はその日の 8 時から進める
beforeEach(async () => {
  clock = fixedClock(jst(8));
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
});

/**
 * 時計を進めてからログインする。ログインセッションは操作が 2 時間無いと切れるので、進めた後に作る
 * @param at 進める先
 */
async function signInAt(at: number): Promise<void> {
  clock.advance(at - clock.now());
  headers = await gate.signIn();
}
afterEach(() => d1.dispose());

const ROW = {
  scheduledAm: "0190f4a8-0000-7000-8000-0000000000a1",
  stopped: "0190f4a8-0000-7000-8000-0000000000a2",
  scheduledPm: "0190f4a8-0000-7000-8000-0000000000a3",
  extension: "0190f4a8-0000-7000-8000-0000000000a4",
  extensionFixed: "0190f4a8-0000-7000-8000-0000000000a5",
};

const NODE = "0190f4a8-0000-7000-8000-000000000001";

/**
 * 勤怠の行を 1 行足す
 * @param row 足す行
 * @param row.id ID
 * @param row.kind 区分
 * @param row.from 始まり
 * @param row.to 終わり
 * @param row.reason 理由
 * @param row.corrects 訂正する行の ID
 * @param row.staffId 社員 ID
 * @returns 文
 */
function attendance(row: { id: string; kind: string; from: number; to: number; reason: string; corrects?: string; staffId?: string }) {
  return d1.DB.prepare("INSERT INTO attendance (id, staff_id, day, kind, started_at, ended_at, reason, corrects, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
    row.id,
    row.staffId ?? "builder",
    DAY,
    row.kind,
    row.from,
    row.to,
    row.reason,
    row.corrects ?? null,
    row.corrects ? "直した" : null,
    row.to,
  );
}

/**
 * した仕事を 1 行足す
 * @param id ID
 * @param title タスクの名前
 * @param from 始めた時刻
 * @param to 終えた時刻
 * @param activeMs 掛かった時間
 * @param corrects 訂正する行の ID
 * @returns 文
 */
function work(id: string, title: string, from: number, to: number, activeMs: number, corrects: string | null = null) {
  return d1.DB.prepare("INSERT INTO work_entries (id, staff_id, day, node_id, scope, title, started_at, ended_at, active_ms, result, corrects) VALUES (?, 'builder', ?, ?, 'knowidea-ui', ?, ?, ?, ?, 'done', ?)").bind(
    id,
    DAY,
    NODE,
    title,
    from,
    to,
    activeMs,
    corrects,
  );
}

/**
 * 9 時から 17 時 10 分まで働き、12 時から 15 分止められ、延長を 17 時 10 分までに直した日を置く
 */
async function seedDay(): Promise<void> {
  await d1.DB.batch([
    attendance({ id: ROW.scheduledAm, kind: "scheduled", from: jst(9), to: jst(12), reason: "schedule" }),
    attendance({ id: ROW.stopped, kind: "stopped", from: jst(12), to: jst(12, 15), reason: "guard_stop" }),
    attendance({ id: ROW.scheduledPm, kind: "scheduled", from: jst(12, 15), to: jst(17), reason: "schedule" }),
    attendance({ id: ROW.extension, kind: "extension", from: jst(17), to: jst(17, 5), reason: "checkpoint_wait" }),
    attendance({ id: ROW.extensionFixed, kind: "extension", from: jst(17), to: jst(17, 10), reason: "checkpoint_wait", corrects: ROW.extension }),
    // 書いた順と始めた順を変えておく
    work("0190f4a8-0000-7000-8000-0000000000b3", "勤怠の表の画面を作る", jst(13, 30), jst(17, 10), 205 * MINUTE),
    work("0190f4a8-0000-7000-8000-0000000000b1", "DiffView の行番号を直す", jst(9), jst(10, 40), 100 * MINUTE),
    work("0190f4a8-0000-7000-8000-0000000000b2", "CodeEditor のページをたす", jst(10, 45), jst(13, 20), 140 * MINUTE),
    work("0190f4a8-0000-7000-8000-0000000000b4", "CodeEditor のページを足す", jst(10, 45), jst(13, 20), 140 * MINUTE, "0190f4a8-0000-7000-8000-0000000000b2"),
    d1.DB.prepare("INSERT INTO daily_totals (staff_id, day, clock_in, clock_out, worked_ms, extension_ms, call_ms, stopped_ms, waiting_ms, reasons) VALUES ('builder', ?, ?, ?, 0, 0, 0, 0, 0, ?)").bind(
      DAY,
      jst(9),
      jst(17, 5),
      JSON.stringify(["extension:checkpoint_wait", "leave_early:schedule"]),
    ),
  ]);
}

const iso = (at: number) => new Date(at).toISOString();

const DayAttendanceBody = z.object({
  data: z.object({ summary: z.record(z.string(), z.unknown()), entries: z.array(z.record(z.string(), z.unknown())) }),
  meta: z.object({ traceId: z.string() }),
});

/**
 * 1 日の勤怠を読む
 * @param day 日
 * @returns 返事の data
 */
async function dayAttendance(day = DAY) {
  const res = await gate.request(`/api/v1/staff/builder/attendance?day=${day}`, { headers });
  expect(res.status).toBe(200);
  return DayAttendanceBody.parse(await res.json()).data;
}

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 */
async function stepUp(): Promise<void> {
  await d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(clock.now() + 15 * MINUTE).run();
}

/**
 * 勤怠の行を訂正する
 * @param id 訂正する行の ID
 * @param body 置き換える値
 * @returns 返事
 */
function correct(id: string, body: unknown): Promise<Response> {
  return gate.request(`/api/v1/attendance/${id}/corrections`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const FIX = { kind: "extension", startedAt: iso(jst(17)), endedAt: iso(jst(17, 25)), reason: "checkpoint_wait", note: "チェックの終わりを取り違えた" };

describe("日ごとのタスク", () => {
  it("1 日のタスクを見る", async () => {
    await seedDay();
    await signInAt(jst(18));
    const { summary, entries } = await dayAttendance();
    expect(summary).toEqual({
      staffId: "builder",
      day: DAY,
      clockIn: iso(jst(9)),
      clockOut: iso(jst(17, 10)),
      workedMs: 7 * HOUR + 55 * MINUTE,
      extensionMs: 10 * MINUTE,
      callMs: 0,
      stoppedMs: 15 * MINUTE,
      waitingMs: 0,
      reasons: ["extension:checkpoint_wait", "leave_early:schedule", "stopped:guard_stop"],
    });
    // 時刻の順に並び、訂正された行は訂正の行に置き換わる。掛かった時間は止められていた時間を除いた active_ms
    expect(entries.map((e) => [e["startedAt"], e["endedAt"], e["title"], e["activeMs"], e["scope"], e["result"]])).toEqual([
      [iso(jst(9)), iso(jst(10, 40)), "DiffView の行番号を直す", 100 * MINUTE, "knowidea-ui", "done"],
      [iso(jst(10, 45)), iso(jst(13, 20)), "CodeEditor のページを足す", 140 * MINUTE, "knowidea-ui", "done"],
      [iso(jst(13, 30)), iso(jst(17, 10)), "勤怠の表の画面を作る", 205 * MINUTE, "knowidea-ui", "done"],
    ]);
  });

  it("勤務中の日は、社員 DO の今の区分で働いた時間を補う", async () => {
    await gate.staff.builder.book.wake(jst(9));
    await signInAt(jst(10, 30));
    const { summary, entries } = await dayAttendance();
    expect(summary).toMatchObject({ clockIn: iso(jst(9)), clockOut: null, workedMs: HOUR + 30 * MINUTE });
    expect(entries).toEqual([]);
  });

  it("記録の無い日は 0 の集計と空の表を返す", async () => {
    await signInAt(jst(18));
    const { summary, entries } = await dayAttendance("2030-01-06");
    expect(summary).toEqual({ staffId: "builder", day: "2030-01-06", clockIn: null, clockOut: null, workedMs: 0, extensionMs: 0, callMs: 0, stoppedMs: 0, waitingMs: 0, reasons: [] });
    expect(entries).toEqual([]);
  });
});

describe("勤怠は書き換えない", () => {
  it("誤りを直す", async () => {
    await seedDay();
    await signInAt(jst(18));
    await stepUp();
    const res = await correct(ROW.extensionFixed, FIX);
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`/api/v1/staff/builder/attendance?day=${DAY}`);
    const { data } = z.object({ data: z.record(z.string(), z.unknown()) }).parse(await res.json());
    expect(data).toMatchObject({ staffId: "builder", day: DAY, kind: "extension", startedAt: iso(jst(17)), endedAt: iso(jst(17, 25)), reason: "checkpoint_wait", corrects: ROW.extensionFixed, note: FIX.note });
    expect(gate.audits.map((a) => [a.action, a.target])).toContainEqual(["attendance.correct", data["id"]]);
    expect((await dayAttendance()).summary).toMatchObject({ clockOut: iso(jst(17, 25)), extensionMs: 25 * MINUTE });
  });

  it("同じ行の 2 度目の訂正は 409 の problem+json を返す", async () => {
    await seedDay();
    await signInAt(jst(18));
    await stepUp();
    expect((await correct(ROW.extensionFixed, FIX)).status).toBe(201);
    const res = await correct(ROW.extensionFixed, { ...FIX, endedAt: iso(jst(17, 20)), note: "2 度目" });
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(Problem.parse(await res.json())).toMatchObject({ status: 409, code: "conflict", instance: `/api/v1/attendance/${ROW.extensionFixed}/corrections` });
  });

  it("訂正はパスキーの確認が要り、無い行は 404、ほかの区分と重なれば 409 を返す", async () => {
    await seedDay();
    await signInAt(jst(18));
    expect(Problem.parse(await (await correct(ROW.scheduledAm, FIX)).json()).code).toBe("step_up_required");
    await stepUp();
    expect(Problem.parse(await (await correct("0190f4a8-0000-7000-8000-0000000000ff", FIX)).json())).toMatchObject({ status: 404, code: "not_found" });
    const overlap = { kind: "scheduled", startedAt: iso(jst(9)), endedAt: iso(jst(12, 30)), reason: "schedule", note: "重なる" };
    expect(Problem.parse(await (await correct(ROW.scheduledAm, overlap)).json())).toMatchObject({ status: 409, code: "conflict" });
    expect(Problem.parse(await (await correct(ROW.scheduledAm, { ...overlap, endedAt: iso(jst(8)) })).json())).toMatchObject({ status: 422, code: "validation_failed" });
    expect(gate.audits.filter((a) => a.action === "attendance.correct")).toEqual([]);
  });
});

describe("日ごとの集計", () => {
  it("毎日 0 時 5 分に前の日の集計を作り直す", async () => {
    await seedDay();
    clock.advance(jst(24, 5) - clock.now());
    const waits: Promise<unknown>[] = [];
    runDaily(gate.env, { waitUntil: (p) => waits.push(p) }, clock);
    await Promise.all(waits);
    const rows = await d1.DB.prepare("SELECT staff_id, day, clock_out, worked_ms, stopped_ms, reasons FROM daily_totals ORDER BY staff_id").all();
    // 記録の無い社員の集計は作らない。行に出ない理由は前の集計から引き継ぐ
    expect(rows.results).toEqual([
      { staff_id: "builder", day: DAY, clock_out: jst(17, 10), worked_ms: 7 * HOUR + 55 * MINUTE, stopped_ms: 15 * MINUTE, reasons: JSON.stringify(["extension:checkpoint_wait", "leave_early:schedule", "stopped:guard_stop"]) },
    ]);
    // Cron は協定世界時なので、日本時間の 0 時 5 分は 15 時 5 分
    expect(DAILY_CRON).toBe("5 15 * * *");
    expect(readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8")).toContain(`"${DAILY_CRON}"`);
  });
});
