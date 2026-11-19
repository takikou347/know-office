// デプロイの条件 (deployWhen) の確かめ。サービスに進める時と本番にデプロイする時に、main に入れる確かめと同じ条件の照らし方 (checkConditions) を使う (サービスと拡張の 3.1)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, INHERITED_SETTINGS, type ReleaseCondition } from "@know-office/core";
import { and, eq, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { reviews, serviceSettings, settings } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { checkConditions } from "../work/conditions.ts";
import type { Forge } from "../work/loop.ts";
import { DEFAULT_PREFIX, loadOfficeDefaults, loadServiceSettings, serviceRules } from "./settings.ts";

/** 足りない条件を、オーナーに出す文にする */
const MISSING: Record<ReleaseCondition, string> = {
  checks: "checks (既定のブランチの先のチェックが通っていない)",
  reviewer: "reviewer (レビュー担当が既定のブランチの先のコミットを承認していない)",
  owner: "owner",
};

/** 読んだデプロイの条件と、書く時に重ねる「読んだ版のまま」の条件 */
export type DeployRules = { deployWhen: ReleaseCondition[]; still: SQL };

/**
 * サービスのデプロイの条件を、版と一緒に読む。版を先に読み、値を後に読むので、間に変わっていれば still が合わず断る側に倒れる
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns 条件と、書く時に重ねる条件
 * @throws not_found サービスが無い時
 * @throws internal 置いた値の形が違う時
 */
export async function readDeployRules(db: D1Database, serviceId: string): Promise<DeployRules> {
  const officeVersion = (await loadOfficeDefaults(db)).deployWhen.version;
  const setting = (await loadServiceSettings(db, serviceId)).find((s) => s.key === "deployWhen");
  if (!setting) throw new AppError("internal", "デプロイの条件が読めない");
  const deployWhen = INHERITED_SETTINGS.deployWhen.parse(setting.value);
  const own = sql`COALESCE((SELECT MAX(${serviceSettings.version}) FROM ${serviceSettings} WHERE ${serviceSettings.serviceId} = ${serviceId} AND ${serviceSettings.key} = 'deployWhen'), 0) = ${setting.version}`;
  // 受け継いでいる時だけ office の初期値の版も重ねる。サービスで変えている時は、初期値が変わっても効かない
  const office = sql`COALESCE((SELECT MAX(${settings.version}) FROM ${settings} WHERE ${settings.key} = ${`${DEFAULT_PREFIX}deployWhen`} AND ${settings.scope} = 'office'), 0) = ${officeVersion}`;
  return { deployWhen, still: setting.inherited ? sql`${own} AND ${office}` : own };
}

/**
 * レビュー担当がそのコミットを承認し、オーナーが断っていない行がある事の条件
 * @param repo リポジトリ
 * @param head 確かめたコミット
 * @returns 条件
 */
export function reviewerApproved(repo: string, head: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${reviews} WHERE ${reviews.repo} = ${repo} AND ${reviews.headSha} = ${head} AND ${reviews.reviewerVerdict} = 'approve' AND (${reviews.ownerVerdict} IS NULL OR ${reviews.ownerVerdict} <> 'reject'))`;
}

/**
 * デプロイの条件を、既定のブランチの先のコミットで照らす。オーナーの承認は、頼む操作そのもの
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param deployWhen デプロイの条件
 * @param target リポジトリと既定のブランチの先のコミット
 * @param target.repo リポジトリ
 * @param target.head 既定のブランチの先のコミット
 * @throws conflict 条件がそろっていない時 (足りない条件を detail に並べる)
 * @throws upstream_failed チェックを GitHub から読めない時
 */
export async function requireDeployWhenAt(env: Bindings, forge: Forge, deployWhen: readonly ReleaseCondition[], target: { repo: string; head: string }): Promise<void> {
  const [approved] = await drizzle(env.DB)
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.repo, target.repo), eq(reviews.headSha, target.head), eq(reviews.reviewerVerdict, "approve"), or(isNull(reviews.ownerVerdict), ne(reviews.ownerVerdict, "reject"))))
    .limit(1);
  const met = await checkConditions(forge, deployWhen, { repo: target.repo, sha: target.head }, { reviewer: approved !== undefined, owner: true }, { all: true });
  if (met.kind === "met") return;
  const lacking = [...(met.kind === "failed" ? ["checks (既定のブランチの先のチェックが落ちている)"] : []), ...met.missing.map((c) => MISSING[c])];
  throw new AppError("conflict", `デプロイの条件を満たしていない。足りない条件: ${lacking.join("、")}`);
}

/**
 * サービスに進めてよいかを、サービスの deployWhen で確かめる。オーナーの承認は、進める操作そのもの。チェックは既定のブランチの先のコミットで、レビュー担当の承認は、そのコミットを確かめて承認した reviews の行で確かめる
 * チェックもレビュー担当も求めなければ GitHub を呼ばない。求めるのに GitHub とつないでいなければ、確かめられないので断る
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param service サービス ID とリポジトリ
 * @param service.id サービス ID
 * @param service.repo リポジトリ。まだ決めていなければ null
 * @throws conflict 条件がそろっていない時 (足りない条件を detail に並べる)、確かめられない時 (GitHub とつないでいない、リポジトリが無い)
 * @throws upstream_failed 先のコミットかチェックを GitHub から読めない時
 */
export async function requireDeployConditions(env: Bindings, forge: Forge, service: { id: string; repo: string | null }): Promise<void> {
  const { deployWhen } = await serviceRules(env.DB, service.id);
  if (!deployWhen.includes("checks") && !deployWhen.includes("reviewer")) return;
  if (service.repo === null) throw new AppError("conflict", "リポジトリが無いので、デプロイの条件を確かめられない");
  if (!(await forge.connected())) throw new AppError("conflict", `GitHub と連携していないので、デプロイの条件 (${deployWhen.join(", ")}) を確かめられない`);
  const head = await forge.defaultHead(service.repo);
  await requireDeployWhenAt(env, forge, deployWhen, { repo: service.repo, head });
}
