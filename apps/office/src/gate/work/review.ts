// レビューの判断に共通の中身。リポジトリへの操作をルールと照らし、main に入れられるかを決めて入れ、レビューと作った社員のタスクを読む (タスクとレビューの 3.1、3.4、3.6)
import { AppError, CommitSha, decideRepo, docsMergeNeeds, StaffId, missingConditions, ownerGuardedPath, type ReleaseCondition, type RepoAction, type ServiceRules } from "@know-office/core";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { nodes, reviews, services } from "../db/main.ts";
import { isFirstDocs, verifyDocsPr } from "../devloop/docs-pr.ts";
import type { Bindings } from "../env.ts";
import { repoScope } from "../github/rules.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { type Forge, notifyStaff } from "./loop.ts";
import { type Actor, appendNodeEvent, findNode, moveNode, type NodeRow, revertNode } from "./nodes.ts";

/** マイグレーションで 2 番目に登録した know-office 自身のサービス。このリポジトリの守りのファイルを変える PR はオーナーの承認も要る (タスクとレビューの 3.7) */
const SELF_SERVICE_ID = "00000000-0000-7000-8000-000000000102";

/** レビューの行 */
export type ReviewRow = typeof reviews.$inferSelect;

/**
 * リポジトリへの操作をルールと照らす。触れるリポジトリ、手で止める、できる操作を先に見て、通る時だけ変わるファイルを読んで触れない所を見る
 * @param env バインディング
 * @param forge GitHub
 * @param req 操作、リポジトリ、ブランチか変わるファイル
 * @param req.action 操作の種類
 * @param req.repo リポジトリ
 * @param req.branch 変えたブランチかコミット。paths が無い時は GitHub から変えたファイルを読む
 * @param req.paths 変わるファイル。分かっている時に渡す
 * @returns 断る理由と当たった道。通すなら null
 * @throws upstream_failed 変えたファイルを GitHub から読めない時
 */
export async function repoRefusal(env: Bindings, forge: Forge, req: { action: RepoAction; repo: string; branch: string; paths?: readonly string[] }): Promise<{ reason: string; path?: string } | null> {
  return (await checkRepo(env, forge, req)).refusal;
}

/**
 * repoRefusal の中身。通した時は、確かめた変わるファイルも返す
 * @param env バインディング
 * @param forge GitHub
 * @param req 操作、リポジトリ、ブランチかコミット、変わるファイル
 * @param req.action 操作の種類
 * @param req.repo リポジトリ
 * @param req.branch 変えたブランチかコミット
 * @param req.paths 変わるファイル。分かっている時に渡す
 * @returns 断る理由と、通した時の変わるファイル、そのリポジトリの設定、設計書のリポジトリか
 * @throws upstream_failed 変えたファイルを GitHub から読めない時
 */
async function checkRepo(
  env: Bindings,
  forge: Forge,
  req: { action: RepoAction; repo: string; branch: string; paths?: readonly string[] },
): Promise<{ refusal: { reason: string; path?: string } | null; paths: readonly string[]; rules: ServiceRules; docs: boolean }> {
  const scope = await repoScope(env.DB, req.repo);
  const first = decideRepo({ action: req.action, repo: req.repo, paths: [] }, scope);
  if (!first.allow) return { refusal: { reason: first.reason }, paths: [], rules: scope.rules, docs: scope.docs };
  const paths = req.paths ?? (await forge.changedPaths(req.repo, req.branch));
  const decision = decideRepo({ action: req.action, repo: req.repo, paths }, scope);
  if (decision.allow) return { refusal: null, paths: paths ?? [], rules: scope.rules, docs: scope.docs };
  return { refusal: decision.path === undefined ? { reason: decision.reason } : { reason: decision.reason, path: decision.path }, paths: [], rules: scope.rules, docs: scope.docs };
}

/** main に入れられるかの答え。入れられる時は、確かめたコミットまで入れる。failed は要るチェックが落ちた事 */
export type MergeGate = { kind: "ready"; sha: string } | { kind: "refused"; reason: string } | { kind: "waiting"; reason: string } | { kind: "failed"; reason: string };

/**
 * リポジトリが know-office 自身のサービスのリポジトリかを読む
 * @param db 今の状態の D1
 * @param repo リポジトリ
 * @returns know-office 自身なら true
 */
async function selfRepo(db: D1Database, repo: string): Promise<boolean> {
  const [row] = await drizzle(db).select({ id: services.id }).from(services).where(and(eq(services.id, SELF_SERVICE_ID), eq(services.repo, repo))).limit(1);
  return row !== undefined;
}

/**
 * 承認の後に main に入れられるかを決める。レビューで確かめたコミット (head_sha) について、できる操作と触れない所をルールと照らし、main に入れる条件 (タスクとレビューの 3.4) がそろったかを見る
 * know-office 自身のリポジトリで守りのファイル (3.7) を変える時は、条件にオーナーの承認を足す。レビュー担当とオーナーの承認が足りない間は、GitHub にチェックを聞かずに待つ
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param review リポジトリ、ブランチ、プルリクエストの番号、この呼び出しが出した承認
 * @param review.repo リポジトリ
 * @param review.branch ブランチ
 * @param review.prNumber プルリクエストの番号
 * @param review.reviewer レビュー担当が承認しているか。null なら reviews の行から読む
 * @returns 入れられるか、断ったか、待つ条件
 * @throws upstream_failed GitHub から読めない時
 */
export async function mergeGate(env: Bindings, forge: Forge, made: NodeRow, review: { repo: string; branch: string; prNumber: number; reviewer: boolean | null }): Promise<MergeGate> {
  const [row] = await drizzle(env.DB).select({ headSha: reviews.headSha, ownerVerdict: reviews.ownerVerdict, reviewerVerdict: reviews.reviewerVerdict }).from(reviews).where(eq(reviews.nodeId, made.id)).limit(1);
  // 確かめたコミットが分からなければ、何を入れるか決められないので断る
  const sha = CommitSha.safeParse(row?.headSha);
  if (!row || !sha.success) return { kind: "refused", reason: "確かめたコミットが分からない" };
  const checked = await checkRepo(env, forge, { action: "merge", repo: review.repo, branch: sha.data });
  if (checked.refusal !== null) return { kind: "refused", reason: checked.refusal.reason };
  let when: readonly ReleaseCondition[];
  if (checked.docs) {
    // 設計書のリポジトリは、確かめたコミットの形をここでも確かめる。PR を出した後に押された物を、形の外れたまま入れない
    const shape = await verifyDocsPr(forge, review.repo, sha.data, checked.paths);
    if (shape.kind === "refused") return { kind: "refused", reason: shape.reason };
    if (shape.kind === "waiting") return { kind: "waiting", reason: shape.reason };
    // 最初の設計書だけオーナーの承認も要る。office とサービスの設定は読まない
    when = docsMergeNeeds(await isFirstDocs(forge, review.repo, shape.name));
  } else {
    const guarded = ownerGuardedPath(checked.paths) !== undefined && (await selfRepo(env.DB, review.repo));
    when = guarded && !checked.rules.mergeWhen.includes("owner") ? [...checked.rules.mergeWhen, "owner" as const] : checked.rules.mergeWhen;
  }
  const approvals = { reviewer: review.reviewer ?? row.reviewerVerdict === "approve", owner: row.ownerVerdict === "approve" };
  const others = missingConditions(when, { checks: true, ...approvals });
  if (others.length > 0) return { kind: "waiting", reason: others.join(",") };
  // チェックが分からない時は入れない
  const checks = when.includes("checks") ? await forge.checkState(review.repo, sha.data) : "passed";
  if (checks === "failed") return { kind: "failed", reason: "checks" };
  const missing = missingConditions(when, { checks: checks === "passed", ...approvals });
  return missing.length === 0 ? { kind: "ready", sha: sha.data } : { kind: "waiting", reason: missing.join(",") };
}

/**
 * 承認されたタスクを done にしてから、main を確かめたコミットまで進める。入れられなければ review に戻す
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param review レビューのタスク
 * @param review.repo リポジトリ
 * @param review.branch ブランチ
 * @param review.sha mergeGate が確かめたコミット
 * @param now 今の時刻
 * @throws conflict 確かめたタスクが読んだ後に変わった時
 */
export async function mergeMade(env: Bindings, forge: Forge, made: NodeRow, review: { repo: string; branch: string; sha: string }, now: number): Promise<void> {
  // 先に done にして、同じタスクを 2 度入れない
  const done = await moveNode(env.DB, made, "done", now);
  if (!done) throw new AppError("conflict", "確かめるタスクが変わった");
  try {
    await forge.merge(review.repo, { branch: review.branch, sha: review.sha });
  } catch (error) {
    await revertNode(env.DB, made.id, "done", "review", now);
    throw error;
  }
}

/**
 * 承認の後に、main に入れられれば入れ、入れたか断ったか待つかをタスクの出来事に残す
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param review リポジトリ、ブランチ、プルリクエストの番号、この呼び出しが出した承認
 * @param review.repo リポジトリ
 * @param review.branch ブランチ
 * @param review.prNumber プルリクエストの番号
 * @param review.reviewer レビュー担当が承認しているか。null なら reviews の行から読む
 * @param approved 承認の出来事。main に入れた後、入れた出来事の前に残す
 * @param approved.staffId 承認した社員。オーナーは null
 * @param approved.kind 出来事の種類
 * @param approved.detail 出来事の中身
 * @param actor 誰がいつ
 * @param guard 自動停止が外へ頼む口。要るチェックが落ちたまま求めた事と、入れた事を自動停止に渡す
 * @returns main に入れたか
 * @throws conflict 確かめたタスクが読んだ後に変わった時
 * @throws upstream_failed GitHub から読めないか、main を進められない時
 */
export async function mergeIfReady(
  env: Bindings,
  forge: Forge,
  made: NodeRow,
  review: { repo: string; branch: string; prNumber: number; reviewer: boolean | null },
  approved: { staffId: string | null; kind: string; detail: Record<string, unknown> },
  actor: Actor,
  guard: GuardDeps,
): Promise<boolean> {
  const gate = await mergeGate(env, forge, made, review);
  // マージの求めは、作った社員のタスクとして数える。落ちたチェックのままの求めは 1 回でタスクを止める (自動停止の 1 章)
  const maker = StaffId.safeParse(made.assignee);
  if (maker.success && (gate.kind === "ready" || gate.kind === "failed")) {
    await observe(env, { type: "merge_requested", staffId: maker.data, nodeId: made.id, checksPassed: gate.kind === "ready" }, actor.now, guard, actor.traceId);
  }
  if (gate.kind === "ready") await mergeMade(env, forge, made, { ...review, sha: gate.sha }, actor.now);
  await appendNodeEvent(env, { nodeId: made.id, ...approved }, actor);
  if (gate.kind === "ready") {
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "merged", detail: { branch: review.branch, sha: gate.sha } }, actor);
    return true;
  }
  await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: gate.kind === "waiting" ? "merge_waiting" : "merge_refused", detail: { reason: gate.reason } }, actor);
  return false;
}

/**
 * レビューの行を、作った社員のタスク ID から読む
 * @param db 今の状態の D1
 * @param nodeId 作った社員のタスク ID
 * @returns レビューの行
 * @throws not_found レビューが無い時
 */
export async function findReview(db: D1Database, nodeId: string): Promise<ReviewRow> {
  const [row] = await drizzle(db).select().from(reviews).where(eq(reviews.nodeId, nodeId)).limit(1);
  if (!row) throw new AppError("not_found", "レビューが無い");
  return row;
}

/**
 * プルリクエストから、確かめるタスク (レビューのタスクでない方) を読む
 * @param db 今の状態の D1
 * @param repo リポジトリ
 * @param prNumber プルリクエストの番号
 * @returns 作った社員のタスク。無ければ null
 */
export async function madeTaskOf(db: D1Database, repo: string, prNumber: number): Promise<NodeRow | null> {
  const [made] = await drizzle(db)
    .select()
    .from(nodes)
    .where(and(eq(nodes.repo, repo), eq(nodes.prNumber, prNumber), ne(nodes.taskKind, "review")))
    .limit(1);
  return made ?? null;
}

/**
 * 作った社員のタスクがレビューを待っている時だけ todo に戻す文を作る。オーナーの差し戻しと指摘を書く文と同じバッチに入れる
 * @param db 今の状態の D1
 * @param nodeId 作った社員のタスク ID
 * @param now 今の時刻
 * @param when 戻す条件。一緒に書く物と同じ条件を渡し、そちらが書けなかった時は戻さない
 * @param when.sql 条件の SQL
 * @param when.args 条件の値
 * @returns 戻す文
 */
export function backToTodo(db: D1Database, nodeId: string, now: number, when: { sql: string; args: unknown[] } = { sql: "1", args: [] }): D1PreparedStatement {
  return db.prepare(`UPDATE nodes SET status = 'todo', version = version + 1, updated_at = ? WHERE id = ? AND status = 'review' AND ${when.sql}`).bind(now, nodeId, ...when.args);
}

/**
 * todo に戻したタスクの担当の社員を呼ぶ。オーナーの指摘は、勤務時間外の社員を呼び出してでも直させる
 * @param env バインディング
 * @param nodeId 戻したタスク ID
 * @param now 今の時刻
 */
export async function callMaker(env: Bindings, nodeId: string, now: number): Promise<void> {
  const made = await findNode(env.DB, nodeId);
  if (made.status === "todo" && made.assignee !== null) await notifyStaff(env, made.assignee, now, true);
}
