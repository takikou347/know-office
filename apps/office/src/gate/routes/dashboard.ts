// ホーム: 社員、承認待ち、オーナーの判断を待つレビュー、今日のタスク、今月の費用と日ごとの推移、動いているサービスの数値、未読の通知を 1 回で返す (API の records)
import { createRoute, z } from "@hono/zod-openapi";
import { type Approval, ApprovalStatus, type DailyCost, Dashboard, type HomeService, jstDay, jstDayStart, jstYear } from "@know-office/core";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { approvals, nodes, notices, services } from "../db/main.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { costHistory } from "../ledger/costs.ts";
import { toNotice } from "../ledger/notices.ts";
import { okResponse, problems } from "../openapi.ts";
import { ok } from "../respond.ts";
import { serviceStatus } from "../services/status.ts";
import { toNode } from "../work/node-view.ts";
import { ownerWaitingReviews } from "../work/owner-reviews.ts";
import { loadStaff } from "./staff.ts";

const router = createRouter();

/** 今日のタスクに出す状態。担当が手を付けている、レビューを待つ、オーナーを待つ */
export const TODAY_STATUSES = ["doing", "review", "waiting_owner"] as const;
/** 今日のタスクの数の上限 */
export const TODAY_LIMIT = 50;
/** 未読の通知の数の上限 */
export const UNREAD_LIMIT = 20;
/** ホームに数値を出すサービスの段階。作った後だけ */
export const LIVE_STAGES = ["prototype", "service", "operation"] as const;
/** ホームに数値を出すサービスの数の上限 */
export const HOME_SERVICES_LIMIT = 50;

const DAY_MS = 24 * 60 * 60_000;

const Payload = z.record(z.string(), z.unknown());
const iso = (at: number) => new Date(at).toISOString();

const getDashboardRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard",
  operationId: "getDashboard",
  tags: ["records"],
  summary: "ホーム",
  description: "今日のタスクは、担当の社員が手を付けている (`doing`)、レビューを待つ (`review`)、オーナーを待つ (`waiting_owner`) タスクを優先度と ID の順に 50 件まで。今月は日本時間の月の 1 日 0 時から。未読の通知は新しい順に 20 件まで。日ごとの費用は今月の 1 日から今日まで、使っていない日も 0 で並べる。サービスの数値は試作、サービス、運用の段階のサービスを ID の順に 50 件まで、サービスの詳細と同じ種類ごとの様子で返す。オーナーの判断を待つレビューは、main に入れる条件にオーナーの承認があるリポジトリで、レビュー担当が承認し、オーナーがまだ決めていない物を、タスクを変えた時刻の古い順に 100 件まで。",
  "x-steps": [
    "3 人分の `StaffDO.status()` を並行して呼び、`staff` の役の名前とモデルを足す。1 人でも答えなければ 500 にする",
    "`pending` の承認、今日のタスク、未読の通知を `DB` から読む",
    "`reviewer_verdict` が `approve` で `owner_verdict` と `merged_at` と `merge_started_at` が無く、タスクが `review` の `reviews` のリポジトリごとに、サービスの設定か office の初期値の `mergeWhen` を読み、`owner` を含むリポジトリの物だけを古い順に 100 件まで読む",
    "今月の `usage.cost_micro_usd` を、その月の年の `REC_<年>` で日本時間の日ごとに足す。今月の費用は `GET /api/v1/records/costs` の今月の合計 (Claude API と Cloudflare の見込み)",
    "`services` の試作、サービス、運用の行ごとに、サービスの詳細と同じ種類ごとの様子を組み立てる",
  ],
  responses: { 200: okResponse(Dashboard), ...problems(401, 403, 429, 500) },
});

/**
 * 日本時間の今月の 1 日 0 時から今までの費用を、日本時間の日ごとに足す。月の年の REC_<年> を読み、使っていない日も 0 で並べる
 * @param env バインディング
 * @param now 今の時刻
 * @returns 1 日から今日までの日ごとの費用 (100 万分の 1 ドル)
 */
export async function dailyCosts(env: Bindings, now: number): Promise<DailyCost[]> {
  const today = jstDay(now);
  const from = jstDayStart(`${today.slice(0, 7)}-01`);
  const days: string[] = [];
  for (let at = from; jstDay(at) <= today; at += DAY_MS) days.push(jstDay(at));
  const name = RECORD_BINDINGS.find((b) => b === `REC_${String(jstYear(now))}`);
  const db = name ? env[name] : undefined;
  const sums = new Map<string, number>();
  if (db) {
    // 日本時間の日は協定世界時に 9 時間を足した日。日の頭からの日数で分ける
    const { results } = await db
      .prepare("SELECT CAST((at - ?) / ? AS INTEGER) AS n, coalesce(sum(cost_micro_usd), 0) AS cost FROM usage WHERE at >= ? AND at <= ? GROUP BY n")
      .bind(from, DAY_MS, from, now)
      .all<{ n: number; cost: number }>();
    for (const r of results) {
      const day = jstDay(from + r.n * DAY_MS);
      sums.set(day, (sums.get(day) ?? 0) + r.cost);
    }
  }
  return days.map((day) => ({ day, costMicroUsd: sums.get(day) ?? 0 }));
}

/**
 * 試作、サービス、運用の段階のサービスの数値を読む
 * @param env バインディング
 * @param now 今の時刻
 * @returns サービスごとの数値
 */
async function liveServices(env: Bindings, now: number): Promise<HomeService[]> {
  const rows = await drizzle(env.DB)
    .select()
    .from(services)
    .where(inArray(services.stage, [...LIVE_STAGES]))
    .orderBy(asc(services.id))
    .limit(HOME_SERVICES_LIMIT);
  return Promise.all(rows.map(async (row) => ({ id: row.id, name: row.name, kind: row.kind, stage: row.stage, status: await serviceStatus(env, row, now) })));
}

/** ホームのルート */
export const dashboardRoutes = router.openapi(getDashboardRoute, async (c) => {
  const now = c.var.clock.now();
  const orm = drizzle(c.env.DB);
  const [staff, waiting, ownerReviews, today, unread, daily, costs, live] = await Promise.all([
    loadStaff(c.env, now),
    orm.select().from(approvals).where(eq(approvals.status, "pending")).orderBy(asc(approvals.id)),
    ownerWaitingReviews(c.env.DB),
    orm
      .select()
      .from(nodes)
      .where(and(eq(nodes.kind, "task"), inArray(nodes.status, [...TODAY_STATUSES])))
      .orderBy(asc(nodes.priority), asc(nodes.id))
      .limit(TODAY_LIMIT),
    orm.select().from(notices).where(isNull(notices.readAt)).orderBy(desc(notices.id)).limit(UNREAD_LIMIT),
    dailyCosts(c.env, now),
    costHistory(c.env, now),
    liveServices(c.env, now),
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
  return ok(c, { staff, approvals: waiting.map(toApproval), ownerReviews, todayTasks: today.map((r) => toNode(r, r.status === "done" ? 1 : 0)), monthCostMicroUsd: costs.months.at(-1)?.totalMicroUsd ?? 0, dailyCosts: daily, services: live, notices: unread.map(toNotice) });
});
