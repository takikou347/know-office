// 社員: 一覧と、その日だけの指示 (社員と勤怠の 3.4、API の staff)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, CreateOrderInput, jstClock, log, newId, Order, StaffId, StaffJob, StaffOverview, WorkSchedule } from "@know-office/core";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { dayOrders } from "../db/main.ts";
import type { Bindings, GateEnv, Staff } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { audit } from "../ledger/record.ts";
import { createdResponse, listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { created, list, ok } from "../respond.ts";
import { type DayOrderRow } from "../work/attendance.ts";
import { addOrder } from "../work/orders.ts";
import { activeStaff } from "../work/roster.ts";

const router = createRouter();

const StaffParam = StaffId.openapi({ param: { name: "staffId", in: "path" }, description: "社員 ID" });
const DayQuery = z.iso.date().openapi({ param: { name: "day", in: "query" }, description: "日本時間の日付 YYYY-MM-DD" });

const listStaffRoute = createRoute({
  method: "get",
  path: "/api/v1/staff",
  operationId: "listStaff",
  tags: ["staff"],
  summary: "社員の現在の状態",
  description: "在籍の社員の状態、担当中のタスク、今日の勤務時間に、職種、組織図の役の名前と上司、モデル、勤務の時刻、設定の版を足す。",
  "x-steps": ["`staff` から在籍の社員を社長、作った順、ID の順に読む", "社員ごとの `StaffDO.status()` を並行して呼ぶ。1 人でも答えなければ 500 にする"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(StaffOverview), ...problems(400, 401, 403, 422, 429, 500) },
});

const listOrdersRoute = createRoute({
  method: "get",
  path: "/api/v1/staff/{staffId}/orders",
  operationId: "listOrders",
  tags: ["staff"],
  summary: "その日の指示",
  description: "取り消した指示も、取り消した時刻を付けて返す。",
  "x-steps": ["`day_orders` からその社員のその日の指示を出した順に読む", "取り消しの行を、取り消した指示の `cancelledAt` にする"],
  request: { params: z.object({ staffId: StaffParam }).strict(), query: z.object({ day: DayQuery }).strict() },
  responses: { 200: okResponse(z.array(Order)), ...problems(400, 401, 403, 422, 429, 500) },
});

const createOrderRoute = createRoute({
  method: "post",
  path: "/api/v1/staff/{staffId}/orders",
  operationId: "createOrder",
  tags: ["staff"],
  summary: "当日のみ有効な指示を出す",
  description: "延長の場合のみ、15 分以内のパスキーの確認が必要。指示は延長、早退、休みで、延長だけが働く時間を増やす。",
  "x-steps": [
    "延長ならパスキーの確認を求める",
    "日が過ぎていないこと、延長は終わりの時刻より後、早退は終わりの時刻より前、`until` が過ぎていないことを、この順に確認する",
    "同じ日に同じ種類の有効な指示がない時だけ、`day_orders` に `source: \"button\"` で 1 文で追加する",
    "`StaffDO.order(o)` で当日の予定を組み直す。届かなければエラーログに残し、社員 DO が次に起きた時に読み直す",
    "監査ログに `order.create` を記録する",
  ],
  "x-errors": [
    "401 `step_up_required`: 延長で、パスキーの確認がない",
    "409 `conflict`: 同じ日に同じ種類の有効な指示がすでにある (同時に出した片方を含む)",
    "409 `refused`: 日か指定時刻を過ぎている、延長が終わりの時刻より前、または早退が終わりの時刻より後。直す事 (終わりの時刻など) を `detail` に書く",
  ],
  "x-step-up": "conditional",
  request: { params: z.object({ staffId: StaffParam }).strict(), body: { required: true, content: { "application/json": { schema: CreateOrderInput } } } },
  responses: {
    201: createdResponse(Order),
    ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500),
  },
});

const cancelOrderRoute = createRoute({
  method: "delete",
  path: "/api/v1/staff/{staffId}/orders/{orderId}",
  operationId: "cancelOrder",
  tags: ["staff"],
  summary: "指示を取り消す",
  description: "取り消しのレコードを追加し、取り消した指示を返す。",
  "x-steps": [
    "その社員の指示を取得する。取り消しの行は指示として扱わない",
    "まだ取り消されていない時だけ、`cancels` を持つ取り消しのレコードを 1 文で追加する",
    "`StaffDO.order(o)` で当日の予定を組み直す。届かなければエラーログに残し、社員 DO が次に起きた時に読み直す",
    "監査ログに `order.cancel` を記録する",
  ],
  "x-errors": ["404 `not_found`: その社員の指示が存在しない", "409 `conflict`: すでに取り消されている"],
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
 * 在籍の社員の今の状態に、組織図の役の名前とモデルと設定を足す。1 人でも答えなければ投げる
 * @param env バインディング
 * @param now 今の時刻
 * @returns 社員の並び。社長、作った順
 */
export async function loadStaff(env: Bindings, now: number): Promise<StaffOverview[]> {
  const rows = await activeStaff(env.DB);
  const statuses = await Promise.all(rows.map((r) => staffOf(env, r.id).status(now)));
  return rows.map((row, i) => {
    const s = statuses[i];
    if (s === undefined) throw new Error("社員の状態が足りない");
    const schedule = WorkSchedule.safeParse(row.schedule);
    return {
      id: row.id,
      job: StaffJob.parse(row.job),
      role: row.role,
      bossId: row.bossId,
      model: row.model,
      schedule: schedule.success ? schedule.data : null,
      version: row.version,
      state: s.state,
      nodeId: s.nodeId,
      nodeTitle: s.nodeTitle,
      workedMsToday: s.workedMsToday,
    };
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
    const row = await addOrder(c.env, { staffId, order: input, source: "button", messageId: null }, c.var.clock.now());
    await replan(c, staffId, row);
    await audit(c, "order.create", row.id, { staffId, day: input.day, kind: input.kind, source: "button" });
    return created(c, toOrder(row, [row]), `/api/v1/staff/${staffId}/orders?day=${input.day}`);
  })
  .openapi(cancelOrderRoute, async (c) => {
    const { staffId, orderId } = c.req.valid("param");
    const orm = drizzle(c.env.DB);
    // 取り消しの行は指示でないので、取り消せる物として探さない
    const [original] = await orm.select().from(dayOrders).where(and(eq(dayOrders.id, orderId), eq(dayOrders.staffId, staffId)));
    if (!original || original.cancels !== null) throw new AppError("not_found", "その社員の指示が無い");
    const now = c.var.clock.now();
    // 取り消しは画面のボタンで行うので、会話の言葉から足した指示でも source は button にし、元の発言 ID を持たない
    const cancel: DayOrderRow = { ...original, id: newId(c.var.clock), until: null, source: "button", cancels: orderId, createdAt: now, messageId: null };
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
