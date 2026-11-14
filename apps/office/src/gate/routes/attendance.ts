// 勤怠: 1 日の勤怠と、勤怠の訂正 (社員と勤怠の 3.6 と 3.7、ルートの一覧の 1.3 と 1.4)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, AttendanceRow, CorrectAttendanceInput, DayAttendance, type DaySummary, StaffId, type WorkEntry } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { attendance } from "../db/main.ts";
import type { GateEnv, Staff } from "../env.ts";
import { audit } from "../ledger/record.ts";
import { okResponse, problems } from "../openapi.ts";
import { created, ok } from "../respond.ts";
import { rethrowRpc } from "../rpc.ts";
import { loadDay, type Totals, type WorkEntryRow } from "../work/attendance.ts";

const router = createRouter();

const StaffParam = StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID。役割ごとに固定" });

const getDayAttendanceRoute = createRoute({
  method: "get",
  path: "/api/v1/staff/{staffId}/attendance",
  operationId: "getDayAttendance",
  tags: ["staff"],
  request: {
    params: z.object({ staffId: StaffParam }).strict(),
    query: z.object({ day: z.iso.date().openapi({ param: { name: "day", in: "query" }, description: "日本時間の日付 YYYY-MM-DD" }) }).strict(),
  },
  responses: { 200: okResponse(DayAttendance), ...problems(400, 401, 403, 404, 422, 429, 500) },
});

const correctAttendanceRoute = createRoute({
  method: "post",
  path: "/api/v1/attendance/{attendanceId}/corrections",
  operationId: "correctAttendance",
  tags: ["records"],
  "x-step-up": true,
  request: {
    params: z.object({ attendanceId: z.uuid().openapi({ param: { name: "attendanceId", in: "path" }, description: "UUID v7" }) }).strict(),
    body: { required: true, content: { "application/json": { schema: CorrectAttendanceInput } } },
  },
  responses: {
    201: { ...okResponse(AttendanceRow, "作成した"), headers: { Location: { description: "作成したリソースの URL", schema: { type: "string" } } } },
    ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500),
  },
});

const iso = (at: number) => new Date(at).toISOString();

/**
 * 社員 DO を返す
 * @param c 要求の文脈
 * @param staffId 社員 ID
 * @returns StaffDO の RPC
 */
function staffOf(c: Context<GateEnv>, staffId: StaffId): Staff {
  return c.env.STAFF.get(c.env.STAFF.idFromName(staffId));
}

/**
 * 集計の行を返す形にする
 * @param t 集計の行
 * @param staffId 社員 ID
 * @returns 1 日の勤怠のまとめ
 */
function toSummary(t: Totals, staffId: StaffId): DaySummary {
  return {
    staffId,
    day: t.day,
    clockIn: typeof t.clockIn === "number" ? iso(t.clockIn) : null,
    clockOut: typeof t.clockOut === "number" ? iso(t.clockOut) : null,
    workedMs: t.workedMs,
    extensionMs: t.extensionMs,
    callMs: t.callMs,
    stoppedMs: t.stoppedMs,
    waitingMs: t.waitingMs,
    reasons: z.array(z.string()).parse(t.reasons ?? []),
  };
}

/**
 * した仕事の行を返す形にする
 * @param row work_entries の行
 * @returns タスク 1 件
 */
function toEntry(row: WorkEntryRow): WorkEntry {
  return { id: row.id, nodeId: row.nodeId, scope: row.scope, title: row.title, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt), activeMs: row.activeMs, result: row.result };
}

/** 勤怠のルート: 1 日の勤怠と訂正 */
export const attendanceRoutes = router
  .openapi(getDayAttendanceRoute, async (c) => {
    const { staffId } = c.req.valid("param");
    const { day } = c.req.valid("query");
    const { totals, entries } = await loadDay(c.env.DB, staffId, day);
    const summary = toSummary(totals, staffId);
    // 出勤していて退勤していない日は、開いている区分がまだ D1 に無いので、社員 DO の今の働いた時間で補う
    if (summary.clockIn !== null && summary.clockOut === null) {
      const status = await staffOf(c, staffId).status(c.var.clock.now());
      if (status.state !== "off") summary.workedMs = Math.max(summary.workedMs, status.workedMsToday);
    }
    return ok(c, { summary, entries: entries.map(toEntry) });
  })
  .openapi(correctAttendanceRoute, async (c) => {
    requireStepUp(c);
    const { attendanceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const orm = drizzle(c.env.DB);
    const [original] = await orm.select({ staffId: attendance.staffId }).from(attendance).where(eq(attendance.id, attendanceId));
    if (!original) throw new AppError("not_found", "訂正する勤怠の行が無い");
    const staffId = StaffId.parse(original.staffId);
    // 読んでから書くまでの間にほかの区分や訂正が入らないよう、その社員の DO の鎖で訂正する
    const values = { kind: input.kind, startedAt: Date.parse(input.startedAt), endedAt: Date.parse(input.endedAt), reason: input.reason, note: input.note };
    const { id } = await staffOf(c, staffId).correct(attendanceId, values, c.var.clock.now()).catch(rethrowRpc);
    const [row] = await orm.select().from(attendance).where(eq(attendance.id, id));
    if (!row) throw new AppError("internal", "足した訂正の行が読めない");
    await audit(c, "attendance.correct", id, { corrects: attendanceId });
    const data: AttendanceRow = {
      id: row.id,
      staffId,
      day: row.day,
      kind: row.kind,
      startedAt: iso(row.startedAt),
      endedAt: iso(row.endedAt),
      reason: input.reason,
      corrects: row.corrects,
      note: input.note,
      createdAt: iso(row.createdAt),
    };
    return created(c, data, `/api/v1/staff/${staffId}/attendance?day=${row.day}`);
  });
