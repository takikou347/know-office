// 本番にデプロイする。オーナーが頼んだ時と main に push した時に、既定のブランチの先のコミットでデプロイの条件を確かめ、読んだ版のままの時だけ deploy.yml を動かす (サービスと拡張の 3.1)
import { AppError, type Deployment, GitHubPushEvent, log, newId } from "@know-office/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { claimLockWhen, releaseLock } from "../db/locks.ts";
import { locks, services } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { auditFrom } from "../ledger/record.ts";
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

/** 頼んだ者。オーナーのボタンは頼む操作そのものがオーナーの承認で、main への push はオーナーの承認にならない */
export type DeployBy = "owner" | "push";

/**
 * 本番にデプロイする。デプロイの条件を既定のブランチの先のコミットで照らし、読んだ版のまま、直前に頼んでも戻してもいない時だけ錠を 1 文で取って、deploy.yml を確かめたコミットを sha に入れて動かす
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param input サービス、今の時刻、頼んだ者
 * @param input.serviceId サービス ID
 * @param input.now 今の時刻
 * @param input.by 頼んだ者
 * @returns 受け付けと、動かしたコミットと ref
 * @throws not_found サービスが無い時
 * @throws refused Web アプリでない、サービスか運用の段階でない、リポジトリが無い、GitHub とつないでいない、条件が足りない (push でオーナーの承認を求める時を含む) 時
 * @throws conflict 直前 10 分に頼んだか戻した、読んだ後に設定が変わった時
 * @throws rate_limited GitHub の上限に当たった時。錠を外す
 * @throws upstream_failed 先のコミットかチェックを読めない時、workflow を動かせない時。錠を外す
 */
export async function deployService(env: Bindings, forge: Forge, input: { serviceId: string; now: number; by: DeployBy }): Promise<Deployment & { sha: string; ref: string }> {
  const { serviceId, now, by } = input;
  const row = await findService(env.DB, serviceId);
  if (row.kind !== "web_app") throw new AppError("refused", "Web アプリでないので、本番にデプロイできない");
  if (!(DEPLOY_STAGES as readonly string[]).includes(row.stage)) throw new AppError("refused", "サービスか運用の段階でないので、本番にデプロイできない");
  const repo = row.repo;
  if (repo === null) throw new AppError("refused", "リポジトリが無いので、本番にデプロイできない");
  const rules = await readDeployRules(env.DB, serviceId);
  // push はオーナーの承認にならないので、求める時は GitHub を読まずに断る。オーナーはボタンで頼む
  if (by === "push" && rules.deployWhen.includes("owner")) throw new AppError("refused", "デプロイの条件を満たしていない。足りない条件: owner");
  if (!(await forge.connected())) throw new AppError("refused", "GitHub と連携していないので、本番にデプロイできない");
  const head = await forge.defaultHead(repo);
  await requireDeployWhenAt(env, forge, rules.deployWhen, { repo, head }, { owner: by === "owner" });
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

/**
 * 既定のブランチへの push を受け、そのリポジトリの Web アプリのうちサービスか運用の段階の物を、ボタンと同じ口で本番にデプロイし、頼んだ事を system の監査ログに残す。条件が足りない時と頼めない時はログに残すだけで、通知は受ける
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param payload 通知の本文
 * @param now 今の時刻
 */
export async function deployPushed(env: Bindings, forge: Forge, payload: unknown, now: number): Promise<void> {
  const parsed = GitHubPushEvent.safeParse(payload);
  if (!parsed.success) return;
  const push = parsed.data;
  if (push.ref !== `refs/heads/${push.repository.default_branch}`) return;
  const repo = push.repository.full_name;
  const targets = await drizzle(env.DB)
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.repo, repo), eq(services.kind, "web_app"), inArray(services.stage, [...DEPLOY_STAGES])))
    .orderBy(asc(services.id));
  for (const target of targets) {
    try {
      const done = await deployService(env, forge, { serviceId: target.id, now, by: "push" });
      // ボタンと同じく頼んだ事を監査ログに残す。頼んだのはオーナーでないので actor は system
      await auditFrom(env, { at: now, actor: "system", action: "service.deploy", target: target.id, scope: target.id, detail: { sha: done.sha, ref: done.ref, deploymentId: done.id } });
      log("info", "service.deploy.push", { serviceId: target.id, sha: done.sha, deploymentId: done.id });
    } catch (error) {
      // 足りない、重なる、GitHub が答えない時は本番に出さないだけにする。オーナーは画面のボタンで頼み直せる
      if (!(error instanceof AppError)) throw error;
      log("info", "service.deploy.push.skipped", { serviceId: target.id, code: error.code, detail: error.message });
    }
  }
}
