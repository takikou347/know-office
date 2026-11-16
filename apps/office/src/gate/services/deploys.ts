// デプロイの通知と 5 分ごとの様子から、service_events の deploy、service_metrics、自動停止の deploy_result を作る (サービスと拡張の 3.2、自動停止の 3.1)
import { DeployDetail, GitHubDeploymentStatusEvent, GitHubWorkflowRunEvent, newId } from "@know-office/core";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services, serviceEvents } from "../db/main.ts";
import { serviceMetrics } from "../db/records.ts";
import { insertedWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import { recordsOf } from "../work/nodes.ts";
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
export type Metrics = { requests: number; errors: number; users: number | null; reads: number | null };

/** サービスの様子を外から読む口。本物の分析の API は #131 でつなぐ */
export type Analytics = {
  /** from から to (含まない) の様子を読む。読めなければ null */
  read(service: { id: string; repo: string | null; kind: string }, from: number, to: number): Promise<Metrics | null>;
};

/** まだつないでいない口。何も読まず、何も書かせない */
export const UNCONNECTED_ANALYTICS: Analytics = { read: () => Promise.resolve(null) };

/**
 * 本番のデプロイが終わった通知を受け、Web アプリとコンテンツのサービスに deploy を残す。戻しのデプロイと本番でない環境は残さない
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
 * Web アプリの、直前のデプロイの時刻と、その前 24 時間の失敗率を読む
 * @param env バインディング
 * @param serviceId サービス ID
 * @param at 区切りの終わり
 * @returns デプロイの時刻と失敗率。窓の中のデプロイが無ければ null
 */
async function recentDeploy(env: Bindings, serviceId: string, at: number): Promise<{ deployedAt: number; baselineRate: number } | null> {
  const [deploy] = await drizzle(env.DB)
    .select({ at: serviceEvents.at, detail: serviceEvents.detail })
    .from(serviceEvents)
    .where(and(eq(serviceEvents.serviceId, serviceId), eq(serviceEvents.kind, "deploy"), lte(serviceEvents.at, at)))
    .orderBy(desc(serviceEvents.at), sql`rowid DESC`)
    .limit(1);
  // 窓はデプロイからちょうど 10 分の区切りまで
  if (!deploy || !DeployDetail.safeParse(deploy.detail).success || at > deploy.at + DEPLOY_WINDOW_MS) return null;
  const [base] = await drizzle(recordsOf(env, deploy.at))
    .select({ requests: sql<number>`COALESCE(SUM(${serviceMetrics.requests}), 0)`, errors: sql<number>`COALESCE(SUM(${serviceMetrics.errors}), 0)` })
    .from(serviceMetrics)
    .where(and(eq(serviceMetrics.serviceId, serviceId), gt(serviceMetrics.at, deploy.at - BASELINE_MS), lte(serviceMetrics.at, deploy.at)));
  const requests = base?.requests ?? 0;
  return { deployedAt: deploy.at, baselineRate: requests > 0 ? Math.min(1, (base?.errors ?? 0) / requests) : 0 };
}

/**
 * 5 分ごとに、リポジトリのある Web アプリとコンテンツの直前の 5 分の様子を読んで service_metrics に残す。同じ区切りは 1 行だけで、
 * 書けた 1 つだけが、デプロイから 10 分の間の返事と失敗を自動停止に渡す。数え済みの区切りは service_metrics の行そのもので決める
 * @param env バインディング
 * @param analytics 様子を読む口
 * @param now 今の時刻
 * @param deps 自動停止が外へ頼む口
 */
export async function collectMetrics(env: Bindings, analytics: Analytics, now: number, deps: GuardDeps): Promise<void> {
  const at = Math.floor(now / METRICS_STEP_MS) * METRICS_STEP_MS;
  const watched = await drizzle(env.DB)
    .select({ id: services.id, repo: services.repo, kind: services.kind })
    .from(services)
    .where(and(inArray(services.kind, ["web_app", "content"]), isNotNull(services.repo), inArray(services.stage, ["prototype", "service", "operation"])))
    .orderBy(asc(services.id));
  for (const service of watched) {
    try {
      const metrics = await analytics.read(service, at - METRICS_STEP_MS, at);
      if (metrics === null) continue;
      const rec = recordsOf(env, at);
      const row = { id: newId(clockAt(now)), serviceId: service.id, at, requests: metrics.requests, errors: metrics.errors, users: metrics.users, reads: metrics.reads, traceId: null };
      const written = await insertedWhen(rec, serviceMetrics, row, sql`NOT EXISTS (SELECT 1 FROM ${serviceMetrics} WHERE ${serviceMetrics.serviceId} = ${service.id} AND ${serviceMetrics.at} = ${at})`);
      if (!written || service.kind !== "web_app") continue;
      const deploy = await recentDeploy(env, service.id, at);
      // 区切りの始まりがデプロイより前なら、デプロイの前の返事が混ざるので数えない
      if (!deploy || at - METRICS_STEP_MS < deploy.deployedAt) continue;
      await observe(env, { type: "deploy_result", serviceId: service.id, kind: "web", deployedAt: deploy.deployedAt, baselineRate: deploy.baselineRate, responses: metrics.requests, failures: metrics.errors }, at, deps);
    } catch (error) {
      // 1 つのサービスが読めなくても、ほかのサービスは読む
      await recordError(env, { source: "job", level: "warn", code: "service_metrics_failed", error }, clockAt(now));
    }
  }
}
