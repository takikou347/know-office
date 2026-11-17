// ダッシュボード: 社員、承認待ち、今日のタスク、今月の費用、未読の通知を 1 回で返す (API の records)
import { createRoute, z } from "@hono/zod-openapi";
import { type Approval, ApprovalStatus, Dashboard, jstDay, jstDayStart, jstYear } from "@know-office/core";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { approvals, nodes, notices } from "../db/main.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { toNotice } from "../ledger/notices.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { toNode } from "../work/node-view.ts";
import { loadStaff } from "./staff.ts";

const router = createRouter();

/** 今日のタスクに出す状態。担当が手を付けている、レビューを待つ、オーナーを待つ */
export const TODAY_STATUSES = ["doing", "review", "waiting_owner"] as const;
/** 今日のタスクの数の上限 */
export const TODAY_LIMIT = 50;
/** 未読の通知の数の上限 */
export const UNREAD_LIMIT = 20;

const Payload = z.record(z.string(), z.unknown());
const iso = (at: number) => new Date(at).toISOString();

const getDashboardRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard",
  operationId: "getDashboard",
  tags: ["records"],
  summary: "ダッシュボード",
  description: "今日のタスクは、担当の社員が手を付けている (`doing`)、レビューを待つ (`review`)、オーナーを待つ (`waiting_owner`) タスクを優先度と ID の順に 50 件まで。今月は日本時間の月の 1 日 0 時から。未読の通知は新しい順に 20 件まで。",
  "x-steps": [
    "3 人分の `StaffDO.status()` を並行して呼び、`staff` の役の名前とモデルを足す。1 人でも答えなければ 500 にする",
    "`pending` の承認、今日のタスク、未読の通知を `DB` から読む",
    "今月の `usage.cost_micro_usd` を、その月の年の `REC_<年>` で足す",
  ],
  responses: { 200: okResponse(Dashboard), ...problems(401, 403, 429, 500) },
});

/**
 * 日本時間の今月の 1 日 0 時から今までの費用を足す。月の年の REC_<年> を読む
 * @param env バインディング
 * @param now 今の時刻
 * @returns 100 万分の 1 ドル
 */
export async function monthCost(env: Bindings, now: number): Promise<number> {
  const from = jstDayStart(`${jstDay(now).slice(0, 7)}-01`);
  const name = RECORD_BINDINGS.find((b) => b === `REC_${String(jstYear(now))}`);
  const db = name ? env[name] : undefined;
  if (!db) return 0;
  const row = await db.prepare("SELECT coalesce(sum(cost_micro_usd), 0) AS cost FROM usage WHERE at >= ? AND at <= ?").bind(from, now).first<{ cost: number }>();
  return row?.cost ?? 0;
}

/** ダッシュボードのルート */
export const dashboardRoutes = router.openapi(getDashboardRoute, async (c) => {
  const now = c.var.clock.now();
  const orm = drizzle(c.env.DB);
  const [staff, waiting, today, unread, cost] = await Promise.all([
    loadStaff(c.env, now),
    orm.select().from(approvals).where(eq(approvals.status, "pending")).orderBy(asc(approvals.id)),
    orm
      .select()
      .from(nodes)
      .where(and(eq(nodes.kind, "task"), inArray(nodes.status, [...TODAY_STATUSES])))
      .orderBy(asc(nodes.priority), asc(nodes.id))
      .limit(TODAY_LIMIT),
    orm.select().from(notices).where(isNull(notices.readAt)).orderBy(desc(notices.id)).limit(UNREAD_LIMIT),
    monthCost(c.env, now),
  ]);
  const toApproval = (row: (typeof waiting)[number]): Approval => {
    // D1 の JSON は形を確かめてから返す
    const payload = Payload.safeParse(row.payload);
    return {
      id: row.id,
      kind: row.kind,
      target: row.target,
      payload: payload.success ? payload.data : {},
      status: ApprovalStatus.parse(row.status),
      requestedBy: row.requestedBy,
      requestedAt: iso(row.requestedAt),
      decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
      reason: row.reason,
    };
  };
  return ok(c, { staff, approvals: waiting.map(toApproval), todayTasks: today.map((r) => toNode(r, r.status === "done" ? 1 : 0)), monthCostMicroUsd: cost, notices: unread.map(toNotice) });
});
