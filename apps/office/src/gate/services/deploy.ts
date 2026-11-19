// 本番にデプロイする。オーナーが頼んだ時に、既定のブランチの先のコミットでデプロイの条件を確かめ、読んだ版のままの時だけ deploy.yml を動かす (サービスと拡張の 3.1)
import { AppError, type Deployment, newId } from "@know-office/core";
import { sql } from "drizzle-orm";
import { claimLockWhen, releaseLock } from "../db/locks.ts";
import { locks, services } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import type { Forge } from "../work/loop.ts";
import { readDeployRules, requireDeployWhenAt, reviewerApproved } from "./deploy-when.ts";
import { findService } from "./flow.ts";
import { rollbackLockName } from "./rollback.ts";

/** デプロイを頼んだ後に、同じサービスで次に頼めるまでの間。二重押しと同時の 2 つで重ねて動かさない */
export const DEPLOY_COOLDOWN_MS = 10 * 60_000;

/** デプロイの workflow。そのリポジトリの .github/workflows/ に置き、workflow_dispatch で sha を受ける */
export const DEPLOY_WORKFLOW = "deploy.yml";

/** デプロイできる段階。本番に出す判断はサービスに進める時から */
const DEPLOY_STAGES = ["service", "operation"] as const;

/**
 * デプロイの錠の名前
 * @param serviceId サービス ID
 * @returns 錠の名前
 */
export const deployLockName = (serviceId: string): string => `service.deploy:${serviceId}`;

/**
 * 本番にデプロイする。デプロイの条件を既定のブランチの先のコミットで照らし、読んだ版のまま、直前に頼んでも戻してもいない時だけ錠を 1 文で取って、deploy.yml を確かめたコミットを sha に入れて動かす
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param input サービスと今の時刻
 * @param input.serviceId サービス ID
 * @param input.now 今の時刻
 * @returns 受け付けと、動かしたコミットと ref
 * @throws not_found サービスが無い時
 * @throws conflict Web アプリでない、サービスか運用の段階でない、リポジトリが無い、GitHub とつないでいない、条件が足りない、直前 10 分に頼んだか戻した、読んだ後に設定が変わった時
 * @throws rate_limited GitHub の上限に当たった時。錠を外す
 * @throws upstream_failed 先のコミットかチェックを読めない時、workflow を動かせない時。錠を外す
 */
export async function deployService(env: Bindings, forge: Forge, input: { serviceId: string; now: number }): Promise<Deployment & { sha: string; ref: string }> {
  const { serviceId, now } = input;
  const row = await findService(env.DB, serviceId);
  if (row.kind !== "web_app") throw new AppError("conflict", "Web アプリでないので、本番にデプロイできない");
  if (!(DEPLOY_STAGES as readonly string[]).includes(row.stage)) throw new AppError("conflict", "サービスか運用の段階でないので、本番にデプロイできない");
  const repo = row.repo;
  if (repo === null) throw new AppError("conflict", "リポジトリが無いので、本番にデプロイできない");
  const rules = await readDeployRules(env.DB, serviceId);
  if (!(await forge.connected())) throw new AppError("conflict", "GitHub と連携していないので、本番にデプロイできない");
  const head = await forge.defaultHead(repo);
  await requireDeployWhenAt(env, forge, rules.deployWhen, { repo, head });
  const id = newId(clockAt(now));
  const lock = deployLockName(serviceId);
  // 照らしている間の変更は、読んだ版、リポジトリ、段階、承認を錠と同じ 1 文に重ねて断る。戻してから 10 分の間は、戻した版をすぐ上書きしない
  const still = sql`${rules.still}
    AND EXISTS (SELECT 1 FROM ${services} WHERE ${services.id} = ${serviceId} AND ${services.kind} = 'web_app' AND ${services.repo} = ${repo} AND ${services.stage} IN ('service', 'operation'))
    AND NOT EXISTS (SELECT 1 FROM ${locks} WHERE ${locks.name} = ${rollbackLockName(serviceId)} AND ${locks.until} > ${now})
    ${rules.deployWhen.includes("reviewer") ? sql`AND ${reviewerApproved(repo, head)}` : sql``}`;
  if (!(await claimLockWhen(env.DB, { name: lock, holder: id, now, ttlMs: DEPLOY_COOLDOWN_MS }, still))) {
    throw new AppError("conflict", "直前 10 分にデプロイを頼んだか戻したか、条件を読んだ後に設定が変わった");
  }
  let ref: string;
  try {
    ref = await forge.dispatchWorkflow(repo, DEPLOY_WORKFLOW, { sha: head });
  } catch (error) {
    await releaseLock(env.DB, lock, id);
    if (error instanceof AppError) throw error;
    throw new AppError("upstream_failed", "GitHub にデプロイを頼めない");
  }
  return { id, status: "queued", sha: head, ref };
}
