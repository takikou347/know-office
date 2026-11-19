// デプロイの通知と 5 分ごとの様子から、service_events の deploy、service_metrics、自動停止の deploy_result を作る (サービスと拡張の 3.2、自動停止の 3.1)
import { DeployDetail, GitHubDeploymentStatusEvent, GitHubWorkflowRunEvent, newId } from "@know-office/core";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services, serviceEvents } from "../db/main.ts";
import { serviceMetrics } from "../db/records.ts";
import { insertedWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { ANALYTICS_CAPPED_CODE, ANALYTICS_FAILED_CODE, ANALYTICS_SKIPPED_CODE, recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import { recordsOf } from "../work/nodes.ts";
import { AnalyticsReadError, noticeIfFailing } from "./analytics.ts";
import { ROLLBACK_COOLDOWN_MS } from "./rollback.ts";
import { latestRelease } from "./status.ts";

/** 5 分ごとの様子の 1 区切り */
export const METRICS_STEP_MS = 5 * 60_000;

/** デプロイの後に失敗率を数える間。自動停止の基準の deployWindowMs と同じ */
const DEPLOY_WINDOW_MS = 10 * 60_000;

/** 失敗率の比べの元にする、デプロイの前の間 */
const BASELINE_MS = 24 * 60 * 60_000;

/** 戻しの workflow が作るデプロイの task。戻しの記録は rollback で残すので、デプロイとして数えない */
export const ROLLBACK_TASK = "rollback";

/** ライブラリの npm への公開の workflow */
export const PUBLISH_WORKFLOW = ".github/workflows/publish.yml";

/** サービスの 5 分の様子 */
export type Metrics = {
  /** 呼び出しの数 (Workers の Analytics) */
  requests: number;
  /** Worker のエラー (例外、資源超過、内部エラー) の数 */
  errors: number;
  /** アプリが返した 5xx の数 (Analytics Engine)。数えていなければ null */
  serverErrors: number | null;
  /** 訪問の数。数えていなければ null */
  users: number | null;
  /** コンテンツの読まれた数 */
  reads: number | null;
};

/** 外から読んだ様子。読んだサービスごとの様子と、読まなかったサービスと訳 */
export type AnalyticsRead = {
  /** サービス ID ごとの様子。呼び出しの無かったサービスも 0 の様子で入る */
  metrics: Map<string, Metrics>;
  /** 読まなかったサービスと訳 (スクリプト名の形が違う、1 回に読む上限を超えた) */
  skipped: { serviceId: string; reason: string }[];
};

/** サービスの様子を外から読む口。本物は services/analytics.ts の cloudflareAnalytics */
export type Analytics = {
  /** from から to (含まない) の様子を、全部のサービスまとめて 1 回で読む。つないでいなければ null */
  read(services: { id: string; repo: string | null; kind: string }[], from: number, to: number): Promise<AnalyticsRead | null>;
};

/** まだつないでいない口 (鍵が無い間)。何も読まず、外へ何も送らず、何も書かせない */
export const UNCONNECTED_ANALYTICS: Analytics = { read: () => Promise.resolve(null) };

/**
 * 集まる遅れの分だけ戻して読む長さ。Workers の指標は、直近の数分が集計の遅れで少なく見える (https://developers.cloudflare.com/workers/observability/metrics-and-analytics/ の「slight delay in aggregation and metrics delivery」)。
 * 遅れの長さは文書に数が無いので、1 つ前の区切りを読む
 */
export const METRICS_LAG_MS = METRICS_STEP_MS;

/**
 * そのサービスを、at までの 10 分の間に戻したか。戻しの workflow が task を付け忘れても、戻した版のデプロイを数えない
 * @param env バインディング
 * @param serviceId サービス ID
 * @param at 比べる時刻
 * @returns 戻していれば true
 */
async function rolledBackBefore(env: Bindings, serviceId: string, at: number): Promise<boolean> {
  const [row] = await drizzle(env.DB)
    .select({ at: serviceEvents.at })
    .from(serviceEvents)
    .where(and(eq(serviceEvents.serviceId, serviceId), eq(serviceEvents.kind, "rollback"), gte(serviceEvents.at, at - ROLLBACK_COOLDOWN_MS), lte(serviceEvents.at, at)))
    .limit(1);
  return row !== undefined;
}

/**
 * 本番のデプロイが終わった通知を受け、Web アプリとコンテンツのサービスに deploy を残す。戻しのデプロイ、戻してから 10 分の間のデプロイ、本番でない環境は残さない
 * @param env バインディング
 * @param payload 通知の本文
 * @param now 今の時刻
 */
export async function receiveDeploymentStatus(env: Bindings, payload: unknown, now: number): Promise<void> {
  const parsed = GitHubDeploymentStatusEvent.safeParse(payload);
  if (!parsed.success) return;
  const { deployment, deployment_status: status, repository } = parsed.data;
  if (status.state !== "success" || status.environment.toLowerCase() !== "production" || deployment.task === ROLLBACK_TASK) return;
  const owners = await drizzle(env.DB)
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.repo, repository.full_name), ne(services.kind, "library")));
  for (const owner of owners) {
    if (await rolledBackBefore(env, owner.id, now)) continue;
    const event = { id: newId(clockAt(now)), at: now, serviceId: owner.id, kind: "deploy" as const, by: "system", detail: { deploymentId: deployment.id, version: deployment.sha.slice(0, 7), commit: deployment.sha } };
    await insertedWhen(env.DB, serviceEvents, event, sql`NOT EXISTS (SELECT 1 FROM ${serviceEvents} WHERE ${serviceEvents.serviceId} = ${owner.id} AND ${serviceEvents.kind} = 'deploy' AND json_extract(${serviceEvents.detail}, '$.deploymentId') = ${deployment.id})`);
  }
}

/**
 * ライブラリの公開の workflow が終わった通知を受け、deploy を残して、組めなかったかを自動停止に渡す
 * @param env バインディング
 * @param action 通知の action
 * @param payload 通知の本文
 * @param now 今の時刻
 * @param deps 自動停止が外へ頼む口
 */
export async function receiveWorkflowRun(env: Bindings, action: string | null, payload: unknown, now: number, deps: GuardDeps): Promise<void> {
  const parsed = GitHubWorkflowRunEvent.safeParse(payload);
  if (action !== "completed" || !parsed.success) return;
  const { workflow_run: run, repository } = parsed.data;
  if (run.path !== PUBLISH_WORKFLOW || run.head_branch !== repository.default_branch || run.status !== "completed") return;
  const libraries = await drizzle(env.DB)
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.repo, repository.full_name), eq(services.kind, "library")));
  const passed = run.conclusion === "success";
  for (const library of libraries) {
    const version = (await latestRelease(env.DB, library.id))?.detail.version ?? null;
    const event = { id: newId(clockAt(now)), at: now, serviceId: library.id, kind: "deploy" as const, by: "system", detail: { runId: run.id, passed, version, commit: run.head_sha } };
    const written = await insertedWhen(env.DB, serviceEvents, event, sql`NOT EXISTS (SELECT 1 FROM ${serviceEvents} WHERE ${serviceEvents.serviceId} = ${library.id} AND ${serviceEvents.kind} = 'deploy' AND json_extract(${serviceEvents.detail}, '$.runId') = ${run.id})`);
    // 同じ workflow の通知を 2 度数えない
    if (!written) continue;
    await observe(env, { type: "deploy_result", serviceId: library.id, kind: "library", version: version ?? "0.0.0", buildPassed: passed }, now, deps);
  }
}

/**
 * Web アプリの、直前のデプロイの時刻と、その前 24 時間の失敗率を読む。
 * 今の区切りが 5xx を数えていれば、baseline も 5xx を数えた行 (server_errors が null でない) だけから Worker のエラーと 5xx の和で出す。
 * 5xx を数える前の行しか無ければ、比べられないので null (判断を飛ばす)。5xx を数え始めたデプロイ自身を戻さないため
 * @param env バインディング
 * @param serviceId サービス ID
 * @param at 区切りの終わり
 * @param countsServerErrors 今の区切りが 5xx を数えているか
 * @returns デプロイの時刻と失敗率。窓の中のデプロイが無いか、比べられる行が無ければ null
 */
async function recentDeploy(env: Bindings, serviceId: string, at: number, countsServerErrors: boolean): Promise<{ deployedAt: number; baselineRate: number } | null> {
  const [deploy] = await drizzle(env.DB)
    .select({ at: serviceEvents.at, detail: serviceEvents.detail })
    .from(serviceEvents)
    .where(and(eq(serviceEvents.serviceId, serviceId), eq(serviceEvents.kind, "deploy"), lte(serviceEvents.at, at)))
    .orderBy(desc(serviceEvents.at), sql`rowid DESC`)
    .limit(1);
  // 窓はデプロイからちょうど 10 分の区切りまで
  if (!deploy || !DeployDetail.safeParse(deploy.detail).success || at > deploy.at + DEPLOY_WINDOW_MS) return null;
  if (await rolledBackBefore(env, serviceId, deploy.at)) return null;
  // 5xx を数えた行だけを和に入れ、数える前の行は数だけを数える
  const counted = countsServerErrors ? sql`${serviceMetrics.serverErrors} IS NOT NULL` : sql`1`;
  const [base] = await drizzle(recordsOf(env, deploy.at))
    .select({
      rows: sql<number>`COUNT(*)`,
      countedRows: sql<number>`COALESCE(SUM(CASE WHEN ${counted} THEN 1 ELSE 0 END), 0)`,
      requests: sql<number>`COALESCE(SUM(CASE WHEN ${counted} THEN ${serviceMetrics.requests} ELSE 0 END), 0)`,
      failures: sql<number>`COALESCE(SUM(CASE WHEN ${counted} THEN ${serviceMetrics.errors} + COALESCE(${serviceMetrics.serverErrors}, 0) ELSE 0 END), 0)`,
    })
    .from(serviceMetrics)
    .where(and(eq(serviceMetrics.serviceId, serviceId), gt(serviceMetrics.at, deploy.at - BASELINE_MS), lte(serviceMetrics.at, deploy.at)));
  if ((base?.rows ?? 0) > 0 && (base?.countedRows ?? 0) === 0) return null;
  const requests = base?.requests ?? 0;
  return { deployedAt: deploy.at, baselineRate: requests > 0 ? Math.min(1, (base?.failures ?? 0) / requests) : 0 };
}

/**
 * 5 分ごとに、リポジトリのある Web アプリとコンテンツの 1 つ前の 5 分の様子を、全部まとめて 1 回で読んで service_metrics に残す。
 * 直前の 5 分は集計が遅れて少なく見えるので 1 つ前の区切りを読み、行の at は読んだ区切りの終わり。同じ区切りは 1 行だけで、
 * 書けた 1 つだけが、デプロイから 10 分の間の返事と失敗を自動停止に渡す (窓は読んだ区切りの at で数えるので、遅れの分だけ止めるのが遅れる)。数え済みの区切りは service_metrics の行そのもので決める
 * @param env バインディング
 * @param analytics 様子を読む口
 * @param now 今の時刻
 * @param deps 自動停止が外へ頼む口
 */
export async function collectMetrics(env: Bindings, analytics: Analytics, now: number, deps: GuardDeps): Promise<void> {
  const at = Math.floor((now - METRICS_LAG_MS) / METRICS_STEP_MS) * METRICS_STEP_MS;
  const watched = await drizzle(env.DB)
    .select({ id: services.id, repo: services.repo, kind: services.kind })
    .from(services)
    .where(and(inArray(services.kind, ["web_app", "content"]), isNotNull(services.repo), inArray(services.stage, ["prototype", "service", "operation"])))
    .orderBy(asc(services.id));
  let read: AnalyticsRead | null;
  try {
    read = await analytics.read(watched, at - METRICS_STEP_MS, at);
  } catch (error) {
    // 全部のサービスを 1 回で読むので、落ちたら全部が読めない。同じ区切りの失敗は 1 回と数える
    await recordError(env, { source: "job", level: "warn", code: error instanceof AnalyticsReadError ? ANALYTICS_FAILED_CODE : "service_metrics_failed", error }, clockAt(now));
    if (error instanceof AnalyticsReadError) await noticeIfFailing(env, now, METRICS_STEP_MS);
    return;
  }
  if (read === null) return;
  for (const skip of read.skipped) await recordError(env, { source: "job", level: "warn", code: ANALYTICS_SKIPPED_CODE, error: new AnalyticsReadError(`${skip.reason} (${skip.serviceId})`) }, clockAt(now));
  for (const service of watched) {
    const metrics = read.metrics.get(service.id);
    if (metrics === undefined) continue;
    try {
      // 2 つの API は別々に集まるので、Worker のエラーと 5xx の和が呼び出しの数を超える事がある。失敗は呼び出しの数までにする
      const room = Math.max(0, metrics.requests - metrics.errors);
      const serverErrors = metrics.serverErrors === null ? null : Math.min(metrics.serverErrors, room);
      if (serverErrors !== null && serverErrors < (metrics.serverErrors ?? 0)) {
        await recordError(env, { source: "job", level: "warn", code: ANALYTICS_CAPPED_CODE, error: new AnalyticsReadError(`5xx の数を呼び出しの数までにした (${service.id})`) }, clockAt(now));
      }
      const rec = recordsOf(env, at);
      const row = { id: newId(clockAt(now)), serviceId: service.id, at, requests: metrics.requests, errors: metrics.errors, serverErrors, users: metrics.users, reads: metrics.reads, traceId: null };
      const written = await insertedWhen(rec, serviceMetrics, row, sql`NOT EXISTS (SELECT 1 FROM ${serviceMetrics} WHERE ${serviceMetrics.serviceId} = ${service.id} AND ${serviceMetrics.at} = ${at})`);
      if (!written || service.kind !== "web_app") continue;
      const deploy = await recentDeploy(env, service.id, at, serverErrors !== null);
      // 区切りの始まりがデプロイより前なら、デプロイの前の返事が混ざるので数えない
      if (!deploy || at - METRICS_STEP_MS < deploy.deployedAt) continue;
      await observe(env, { type: "deploy_result", serviceId: service.id, kind: "web", deployedAt: deploy.deployedAt, baselineRate: deploy.baselineRate, responses: metrics.requests, failures: metrics.errors + (serverErrors ?? 0) }, at, deps);
    } catch (error) {
      // 1 つのサービスが書けなくても、ほかのサービスは書く
      await recordError(env, { source: "job", level: "warn", code: "service_metrics_failed", error }, clockAt(now));
    }
  }
}
