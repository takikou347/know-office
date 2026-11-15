// 社員: 一覧と、その日だけの指示 (社員と勤怠の 3.4、ルートの一覧の 1.3)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, type Clock, CreateOrderInput, jstClock, jstDay, jstDayStart, log, newId, Order, StaffId, StaffOverview } from "@know-office/core";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { dayOrders, staff } from "../db/main.ts";
import type { Bindings, GateEnv, Staff } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, ok } from "../respond.ts";
import { type DayOrderRow, loadSchedule } from "../work/attendance.ts";

const router = createRouter();

const StaffParam = StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID。役割ごとに固定" });
const DayQuery = z.iso.date().openapi({ param: { name: "day", in: "query" }, description: "日本時間の日付 YYYY-MM-DD" });

const listStaffRoute = createRoute({
  method: "get",
  path: "/api/v1/staff",
  operationId: "listStaff",
  tags: ["staff"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(StaffOverview), ...problems(400, 401, 403, 422, 429, 500) },
});

const listOrdersRoute = createRoute({
  method: "get",
  path: "/api/v1/staff/{staffId}/orders",
  operationId: "listOrders",
  tags: ["staff"],
  request: { params: z.object({ staffId: StaffParam }).strict(), query: z.object({ day: DayQuery }).strict() },
  responses: { 200: okResponse(z.array(Order)), ...problems(400, 401, 403, 422, 429, 500) },
});

const createOrderRoute = createRoute({
  method: "post",
  path: "/api/v1/staff/{staffId}/orders",
  operationId: "createOrder",
  tags: ["staff"],
  "x-step-up": "conditional",
  request: { params: z.object({ staffId: StaffParam }).strict(), body: { required: true, content: { "application/json": { schema: CreateOrderInput } } } },
  responses: {
    201: { ...okResponse(Order, "作成した"), headers: { Location: { description: "作成したリソースの URL", schema: { type: "string" } } } },
    ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500),
  },
});

const cancelOrderRoute = createRoute({
  method: "delete",
  path: "/api/v1/staff/{staffId}/orders/{orderId}",
  operationId: "cancelOrder",
  tags: ["staff"],
  request: { params: z.object({ staffId: StaffParam, orderId: z.uuid().openapi({ param: { name: "orderId", in: "path" }, description: "UUID v7" }) }).strict() },
  responses: { 200: okResponse(Order), ...problems(401, 403, 404, 409, 422, 429, 500) },
});

const iso = (at: number) => new Date(at).toISOString();

/**
 * 社員 DO を返す
 * @param env バインディング
 * @param staffId 社員 ID
 * @returns StaffDO の RPC
 */
function staffOf(env: Bindings, staffId: StaffId): Staff {
  return env.STAFF.get(env.STAFF.idFromName(staffId));
}

/**
 * 3 人の今の状態に、組織図の役の名前とモデルを足す。1 人でも答えなければ投げる
 * @param env バインディング
 * @param now 今の時刻
 * @returns 社員の並び。社長、開発担当、レビュー担当の順
 */
export async function loadStaff(env: Bindings, now: number): Promise<StaffOverview[]> {
  const [statuses, rows] = await Promise.all([Promise.all(StaffId.options.map((id) => staffOf(env, id).status(now))), drizzle(env.DB).select({ id: staff.id, role: staff.role, model: staff.model }).from(staff)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return statuses.map((s) => {
    const row = byId.get(s.id);
    return { id: s.id, role: row?.role ?? s.id, model: row?.model ?? "", state: s.state, nodeId: s.nodeId, nodeTitle: s.nodeTitle, workedMsToday: s.workedMsToday };
  });
}

/**
 * その社員のその日の指示の行を、出した順に読む。取り消しの行も含む
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @param day 日本時間の日
 * @returns 行
 */
function dayRows(db: Bindings["DB"], staffId: StaffId, day: string): Promise<DayOrderRow[]> {
  return drizzle(db).select().from(dayOrders).where(and(eq(dayOrders.staffId, staffId), eq(dayOrders.day, day))).orderBy(asc(dayOrders.createdAt), asc(dayOrders.id));
}

/**
 * 指示の行を返す形にする
 * @param row 指示の行
 * @param rows 同じ日の行。取り消しの行を探す
 * @returns 指示
 */
function toOrder(row: DayOrderRow, rows: readonly DayOrderRow[]): Order {
  const cancel = rows.find((r) => r.cancels === row.id);
  return {
    id: row.id,
    staffId: StaffId.parse(row.staffId),
    day: row.day,
    kind: z.enum(["extend", "leave_early", "off"]).parse(row.kind),
    until: row.until === null ? null : jstClock(row.until),
    source: row.source,
    cancelledAt: cancel ? iso(cancel.createdAt) : null,
    createdAt: iso(row.createdAt),
  };
}

/**
 * 社員 DO に予定を作り直させる。届かなくても足した行は残り、社員 DO が次に起きた時に D1 から読み直すので、エラーログに残して進める
 * @param c 要求の文脈
 * @param staffId 社員 ID
 * @param row 足した行
 */
async function replan(c: Context<GateEnv>, staffId: StaffId, row: DayOrderRow): Promise<void> {
  try {
    await staffOf(c.env, staffId).order(row, c.var.clock.now());
  } catch (error) {
    log("error", "order_replan_failed", { staffId, traceId: c.var.traceId });
    await recordError(c.env, { source: "gate", level: "error", code: "order_replan_failed", error, route: c.req.routePath, traceId: c.var.traceId }, c.var.clock);
  }
}

/**
 * 指示の終わりの時刻を確かめる。日も時刻も今より後、延長は所定の終わりより後、早退は所定の終わりより前
 * @param db D1 の DB
 * @param input 指示
 * @param clock 時刻
 * @returns 終わりの時刻。休みは null
 * @throws conflict 日か時刻を過ぎている、延長が終わりより前、早退が終わりより後の時
 */
async function untilOf(db: Bindings["DB"], input: CreateOrderInput, clock: Clock): Promise<number | null> {
  const now = clock.now();
  if (input.day < jstDay(now)) throw new AppError("conflict", "過ぎた日の指示は出せない");
  if (input.until === undefined) return null;
  const until = jstDayStart(input.day) + toMinutes(input.until) * 60_000;
  if (until <= now) throw new AppError("conflict", "指定の時刻を過ぎている");
  const end = jstDayStart(input.day) + toMinutes((await loadSchedule(db)).end) * 60_000;
  if (input.kind === "extend" && until <= end) throw new AppError("conflict", "延長は終わりの時刻より後にする");
  if (input.kind === "leave_early" && until >= end) throw new AppError("conflict", "早退は終わりの時刻より前にする");
  return until;
}

/**
 * HH:MM を 0 時からの分にする
 * @param hhmm 時刻
 * @returns 分
 */
function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** 社員のルート: 一覧と、その日だけの指示 */
export const staffRoutes = router
  .openapi(listStaffRoute, async (c) => list(c, await loadStaff(c.env, c.var.clock.now()), null))
  .openapi(listOrdersRoute, async (c) => {
    const { staffId } = c.req.valid("param");
    const rows = await dayRows(c.env.DB, staffId, c.req.valid("query").day);
    return ok(c, rows.filter((r) => r.cancels === null).map((r) => toOrder(r, rows)));
  })
  .openapi(createOrderRoute, async (c) => {
    const input = c.req.valid("json");
    // 延長は働く時間を増やすので、パスキーで確かめる。休みと早退は減らす側なので確かめない
    if (input.kind === "extend") requireStepUp(c);
    const { staffId } = c.req.valid("param");
    const until = await untilOf(c.env.DB, input, c.var.clock);
    const now = c.var.clock.now();
    const row: DayOrderRow = { id: newId(c.var.clock), staffId, day: input.day, kind: input.kind, until, source: "button", cancels: null, createdAt: now };
    // 同じ日の同じ種類の効いている指示が無い時だけ足す。読んでから足すと、同時の 2 つがどちらも無いと読んで重なる
    const res = await c.env.DB.prepare(
      "INSERT INTO day_orders (id, staff_id, day, kind, until, source, cancels, created_at) SELECT ?, ?, ?, ?, ?, 'button', NULL, ? WHERE NOT EXISTS (SELECT 1 FROM day_orders o WHERE o.staff_id = ? AND o.day = ? AND o.kind = ? AND o.cancels IS NULL AND NOT EXISTS (SELECT 1 FROM day_orders x WHERE x.cancels = o.id))",
    )
      .bind(row.id, staffId, input.day, input.kind, until, now, staffId, input.day, input.kind)
      .run();
    if (res.meta.changes !== 1) throw new AppError("conflict", "同じ日に同じ指示がある");
    await replan(c, staffId, row);
    await audit(c, "order.create", row.id, { staffId, day: input.day, kind: input.kind });
    return created(c, toOrder(row, [row]), `/api/v1/staff/${staffId}/orders?day=${input.day}`);
  })
  .openapi(cancelOrderRoute, async (c) => {
    const { staffId, orderId } = c.req.valid("param");
    const orm = drizzle(c.env.DB);
    // 取り消しの行は指示でないので、取り消せる物として探さない
    const [original] = await orm.select().from(dayOrders).where(and(eq(dayOrders.id, orderId), eq(dayOrders.staffId, staffId)));
    if (!original || original.cancels !== null) throw new AppError("not_found", "その社員の指示が無い");
    const now = c.var.clock.now();
    const cancel: DayOrderRow = { ...original, id: newId(c.var.clock), until: null, source: "button", cancels: orderId, createdAt: now };
    // まだ取り消されていない時だけ足す。同時の 2 回は片方だけが書ける
    const res = await c.env.DB.prepare(
      "INSERT INTO day_orders (id, staff_id, day, kind, until, source, cancels, created_at) SELECT ?, ?, ?, ?, NULL, 'button', ?, ? WHERE NOT EXISTS (SELECT 1 FROM day_orders WHERE cancels = ?)",
    )
      .bind(cancel.id, staffId, original.day, original.kind, orderId, now, orderId)
      .run();
    if (res.meta.changes !== 1) throw new AppError("conflict", "もう取り消されている");
    await replan(c, staffId, cancel);
    await audit(c, "order.cancel", orderId, { staffId, day: original.day, kind: original.kind });
    return ok(c, toOrder(original, [original, cancel]));
  });
