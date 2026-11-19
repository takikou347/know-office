// サービスの様子を種類ごとに組み立てる。ライブラリは公開とそろい、使う側の版、Web アプリはデプロイと戻し、利用者数、失敗率、費用、コンテンツは公開した物と読まれた数 (サービスと拡張の 3.2)
import type { D1Database } from "@cloudflare/workers-types";
import { compareSemver, DeployDetail, jstDay, jstDayStart, ReleaseDetail, type ServiceStatus, UsesDetail } from "@know-office/core";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";
import { services, serviceEvents } from "../db/main.ts";
import { serviceMetrics, usage } from "../db/records.ts";
import type { Bindings } from "../env.ts";
import { recordsOf } from "../work/nodes.ts";
import type { ServiceRow } from "./flow.ts";

const DAY_MS = 24 * 60 * 60_000;

/** コンテンツの公開した物を出す数 */
const PUBLISHED_MAX = 20;

const iso = (at: number) => new Date(at).toISOString();

type EventRow = typeof serviceEvents.$inferSelect;

/**
 * 1 つのサービスの、ある種類の出来事を新しい順に読む
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @param kind 出来事の種類
 * @param limit 読む数
 * @returns 出来事の行
 */
function eventsOf(db: D1Database, serviceId: string, kind: EventRow["kind"], limit: number): Promise<EventRow[]> {
  return drizzle(db)
    .select()
    .from(serviceEvents)
    .where(and(eq(serviceEvents.serviceId, serviceId), eq(serviceEvents.kind, kind)))
    .orderBy(desc(serviceEvents.at), sql`rowid DESC`)
    .limit(limit);
}

/**
 * 出来事の detail を形で確かめる。形の違う行は無い物として扱う
 * @param schema detail の形
 * @param row 出来事の行
 * @returns 確かめた detail。形が違えば null
 */
function detailOf<S extends z.ZodType>(schema: S, row: EventRow | undefined): z.output<S> | null {
  if (!row) return null;
  const parsed = schema.safeParse(row.detail);
  return parsed.success ? parsed.data : null;
}

/**
 * ライブラリを使っているサービスと、使っている版を読む。サービスごとに最新の uses の行を使う
 * @param db 今の状態の D1
 * @param libraryId ライブラリのサービス ID
 * @returns サービス、名前、版
 */
export async function usersOf(db: D1Database, libraryId: string): Promise<{ serviceId: string; name: string; staffId: string | null; version: string }[]> {
  const rows = await drizzle(db)
    .select({ serviceId: serviceEvents.serviceId, name: services.name, staffId: services.staffId, detail: serviceEvents.detail, at: serviceEvents.at })
    .from(serviceEvents)
    .innerJoin(services, eq(services.id, serviceEvents.serviceId))
    .where(and(eq(serviceEvents.kind, "uses"), sql`json_extract(${serviceEvents.detail}, '$.library') = ${libraryId}`))
    .orderBy(desc(serviceEvents.at), sql`${serviceEvents}.rowid DESC`);
  const seen = new Map<string, { serviceId: string; name: string; staffId: string | null; version: string }>();
  for (const r of rows) {
    if (seen.has(r.serviceId)) continue;
    const detail = UsesDetail.safeParse(r.detail);
    if (detail.success) seen.set(r.serviceId, { serviceId: r.serviceId, name: r.name, staffId: r.staffId, version: detail.data.version });
  }
  return [...seen.values()];
}

/**
 * ライブラリの最新の公開を読む
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns 公開の detail と時刻。まだ無ければ null
 */
export async function latestRelease(db: D1Database, serviceId: string): Promise<{ at: number; detail: z.output<typeof ReleaseDetail> } | null> {
  const [row] = await eventsOf(db, serviceId, "release", 1);
  const detail = detailOf(ReleaseDetail, row);
  return row && detail ? { at: row.at, detail } : null;
}

/**
 * ライブラリの様子を組み立てる
 * @param db 今の状態の D1
 * @param row サービスの行
 * @returns 様子
 */
async function libraryStatus(db: D1Database, row: ServiceRow): Promise<ServiceStatus> {
  const [release, publishes, users] = await Promise.all([latestRelease(db, row.id), eventsOf(db, row.id, "deploy", 1), usersOf(db, row.id)]);
  const publish = detailOf(DeployDetail, publishes[0]);
  const version = release?.detail.version ?? null;
  return {
    kind: "library",
    version,
    packages: release?.detail.packages ?? [],
    aligned: release?.detail.aligned ?? true,
    releasedAt: release ? iso(release.at) : null,
    publish: publishes[0] && publish && "passed" in publish ? { at: iso(publishes[0].at), passed: publish.passed } : null,
    usedBy: users.map((u) => ({ serviceId: u.serviceId, name: u.name, version: u.version, behind: version !== null && compareSemver(u.version, version) < 0 })),
  };
}

/**
 * 直前 24 時間の様子の和を読む。利用者数は訪問の和で、どの行も null (訪問を数えていない) なら null
 * @param env バインディング
 * @param serviceId サービス ID
 * @param now 今の時刻
 * @returns 返事、失敗、読まれた数、利用者数の和と行の数
 */
async function recentMetrics(env: Bindings, serviceId: string, now: number) {
  const orm = drizzle(recordsOf(env, now));
  const [sum] = await orm
    .select({
      n: sql<number>`COUNT(*)`,
      requests: sql<number>`COALESCE(SUM(${serviceMetrics.requests}), 0)`,
      // 失敗は Worker のエラーとアプリの 5xx の和。5xx を数える前の行は Worker のエラーだけ
      errors: sql<number>`COALESCE(SUM(${serviceMetrics.errors} + COALESCE(${serviceMetrics.serverErrors}, 0)), 0)`,
      reads: sql<number>`COALESCE(SUM(${serviceMetrics.reads}), 0)`,
      // SUM は null の行を飛ばし、どの行も null なら null を返す
      users: sql<number | null>`SUM(${serviceMetrics.users})`,
    })
    .from(serviceMetrics)
    .where(and(eq(serviceMetrics.serviceId, serviceId), gt(serviceMetrics.at, now - DAY_MS)));
  return { n: sum?.n ?? 0, requests: sum?.requests ?? 0, errors: sum?.errors ?? 0, reads: sum?.reads ?? 0, users: sum?.users ?? null };
}

/**
 * Web アプリの様子を組み立てる
 * @param env バインディング
 * @param row サービスの行
 * @param now 今の時刻
 * @returns 様子
 */
async function webAppStatus(env: Bindings, row: ServiceRow, now: number): Promise<ServiceStatus> {
  // 今月は日本時間の 1 日の 0 時から
  const monthStart = jstDayStart(`${jstDay(now).slice(0, 8)}01`);
  const [deploys, rollbacks, metrics, [cost]] = await Promise.all([
    eventsOf(env.DB, row.id, "deploy", 1),
    eventsOf(env.DB, row.id, "rollback", 1),
    recentMetrics(env, row.id, now),
    drizzle(recordsOf(env, now))
      .select({ total: sql<number>`COALESCE(SUM(${usage.costMicroUsd}), 0)` })
      .from(usage)
      .where(and(eq(usage.scope, row.id), gte(usage.at, monthStart))),
  ]);
  const deploy = detailOf(DeployDetail, deploys[0]);
  return {
    kind: "web_app",
    version: deploy?.version ?? null,
    deployedAt: deploys[0] ? iso(deploys[0].at) : null,
    rolledBackAt: rollbacks[0] ? iso(rollbacks[0].at) : null,
    users: metrics.users,
    errorRate: metrics.requests > 0 ? metrics.errors / metrics.requests : null,
    costMicroUsd: cost?.total ?? 0,
  };
}

/**
 * コンテンツの様子を組み立てる
 * @param env バインディング
 * @param row サービスの行
 * @param now 今の時刻
 * @returns 様子
 */
async function contentStatus(env: Bindings, row: ServiceRow, now: number): Promise<ServiceStatus> {
  const [deploys, metrics] = await Promise.all([eventsOf(env.DB, row.id, "deploy", PUBLISHED_MAX), recentMetrics(env, row.id, now)]);
  return {
    kind: "content",
    published: deploys.map((d) => ({ at: iso(d.at), title: detailOf(DeployDetail, d)?.version ?? "" })),
    reads: metrics.n > 0 ? metrics.reads : null,
  };
}

/**
 * サービスの様子を種類ごとに組み立てる
 * @param env バインディング
 * @param row サービスの行
 * @param now 今の時刻
 * @returns 様子
 */
export function serviceStatus(env: Bindings, row: ServiceRow, now: number): Promise<ServiceStatus> {
  if (row.kind === "library") return libraryStatus(env.DB, row);
  if (row.kind === "web_app") return webAppStatus(env, row, now);
  return contentStatus(env, row, now);
}
