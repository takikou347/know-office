// サービスに進める時の、デプロイの条件 (deployWhen) の確かめ。main に入れる確かめと同じ条件の照らし方 (checkConditions) を使う (サービスと拡張の 3.1)
import { AppError, type ReleaseCondition } from "@know-office/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { reviews } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { checkConditions } from "../work/conditions.ts";
import type { Forge } from "../work/loop.ts";
import { serviceRules } from "./settings.ts";

/** 足りない条件を、オーナーに出す文にする */
const MISSING: Record<ReleaseCondition, string> = {
  checks: "checks (既定のブランチの先のチェックが通っていない)",
  reviewer: "reviewer (レビュー担当が既定のブランチの先のコミットを承認していない)",
  owner: "owner",
};

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
  const [approved] = await drizzle(env.DB)
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.repo, service.repo), eq(reviews.headSha, head), eq(reviews.reviewerVerdict, "approve")))
    .limit(1);
  const met = await checkConditions(forge, deployWhen, { repo: service.repo, sha: head }, { reviewer: approved !== undefined, owner: true }, { all: true });
  if (met.kind === "met") return;
  const lacking = [...(met.kind === "failed" ? ["checks (既定のブランチの先のチェックが落ちている)"] : []), ...met.missing.map((c) => MISSING[c])];
  throw new AppError("conflict", `デプロイの条件を満たしていない。足りない条件: ${lacking.join("、")}`);
}
