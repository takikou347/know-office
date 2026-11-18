// レビューの判断に共通の中身。リポジトリへの操作をルールと照らし、main に入れられるかを決めて入れ、レビューと作った社員のタスクを読む (タスクとレビューの 3.1、3.4、3.6)
import { AppError, CommitSha, decideRepo, docsMergeNeeds, log, newId, ownerGuardedPath, type ReleaseCondition, type RepoAction, type ServiceRules, StaffId } from "@know-office/core";
import { and, eq, ne, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { nodes, reviews, services } from "../db/main.ts";
import { insertWhenStatement } from "../db/when.ts";
import { expectedDocsName, isFirstDocs, verifyDocsPr } from "../devloop/docs-pr.ts";
import { childOf, missingTests, readPrFiles } from "../devloop/pr-issue.ts";
import type { Bindings } from "../env.ts";
import { repoScope } from "../github/rules.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { clockAt } from "./attendance.ts";
import { checkConditions } from "./conditions.ts";
import { type Forge, notifyStaff } from "./loop.ts";
import { type DocsTarget, linkedGate } from "./docs-merge.ts";
import { mergeMade } from "./merge-made.ts";
import { type Actor, appendNodeEvent, checkPair, findNode, type NodeRow, recordCreated } from "./nodes.ts";

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
export type MergeGate = { kind: "ready"; sha: string; docs?: DocsTarget } | { kind: "refused"; reason: string } | { kind: "waiting"; reason: string } | { kind: "failed"; reason: string };

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
  const [row] = await drizzle(env.DB).select({ headSha: reviews.headSha, docsHeadSha: reviews.docsHeadSha, ownerVerdict: reviews.ownerVerdict, reviewerVerdict: reviews.reviewerVerdict }).from(reviews).where(eq(reviews.nodeId, made.id)).limit(1);
  // 確かめたコミットが分からなければ、何を入れるか決められないので断る
  const sha = CommitSha.safeParse(row?.headSha);
  if (!row || !sha.success) return { kind: "refused", reason: "確かめたコミットが分からない" };
  // 子 Issue のタスクは、確かめたコミットで変えたファイルを 1 回だけ読み、ルールの確かめとテストの確かめの両方に使う
  const child = await childOf(env.DB, made);
  const found = child === null ? null : await readPrFiles(forge, review.repo, sha.data);
  const checked = await checkRepo(env, forge, { action: "merge", repo: review.repo, branch: sha.data, ...(found === null || found.truncated ? {} : { paths: found.paths }) });
  if (checked.refusal !== null) return { kind: "refused", reason: checked.refusal.reason };
  const noTests = child === null || found === null ? null : missingTests(child, found);
  if (noTests !== null) return { kind: "refused", reason: noTests };
  let when: readonly ReleaseCondition[];
  if (checked.docs) {
    // 設計書のリポジトリは、確かめたコミットの形をここでも確かめる。PR を出した後に押された物を、形の外れたまま入れない
    const shape = await verifyDocsPr(forge, review.repo, sha.data, checked.paths, await expectedDocsName(env.DB, made));
    if (shape.kind === "refused") return { kind: "refused", reason: shape.reason };
    if (shape.kind === "waiting") return { kind: "waiting", reason: shape.reason };
    // 最初の設計書だけオーナーの承認も要る。office とサービスの設定は読まない
    when = docsMergeNeeds(await isFirstDocs(forge, review.repo, shape.name));
  } else {
    const guarded = ownerGuardedPath(checked.paths) !== undefined && (await selfRepo(env.DB, review.repo));
    when = guarded && !checked.rules.mergeWhen.includes("owner") ? [...checked.rules.mergeWhen, "owner" as const] : checked.rules.mergeWhen;
  }
  const approvals = { reviewer: review.reviewer ?? row.reviewerVerdict === "approve", owner: row.ownerVerdict === "approve" };
  const met = await checkConditions(forge, when, { repo: review.repo, sha: sha.data }, approvals);
  if (met.kind === "failed") return { kind: "failed", reason: "checks" };
  if (met.kind === "waiting") return { kind: "waiting", reason: met.missing.join(",") };
  // 設計書の PR を結んだタスクは、設計書の側の条件もそろった時だけ入れる
  const linked = await linkedGate(env, forge, made, row.docsHeadSha, approvals, (repo, docsSha) => checkRepo(env, forge, { action: "merge", repo, branch: docsSha }));
  if (linked.kind === "none") return { kind: "ready", sha: sha.data };
  return linked.kind === "ready" ? { kind: "ready", sha: sha.data, docs: linked.docs } : linked;
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
 * @param options 名前付きの指定
 * @param options.counted マージの求めを作った社員のタスクとして自動停止に数えるか。定期の入れ直し (resumeMerges) は社員の求めでないので false。初期値は true
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
  options: { counted?: boolean } = {},
): Promise<boolean> {
  const gate = await mergeGate(env, forge, made, review);
  // マージの求めは、作った社員のタスクとして数える。落ちたチェックのままの求めは 1 回でタスクを止める (自動停止の 1 章)
  const maker = StaffId.safeParse(made.assignee);
  if (options.counted !== false && maker.success && (gate.kind === "ready" || gate.kind === "failed")) {
    await observe(env, { type: "merge_requested", staffId: maker.data, nodeId: made.id, checksPassed: gate.kind === "ready" }, actor.now, guard, actor.traceId);
  }
  const outcome = gate.kind === "ready" ? await mergeMade(env, forge, made, { repo: review.repo, branch: review.branch, sha: gate.sha, docs: gate.docs }, actor.now) : null;
  await appendNodeEvent(env, { nodeId: made.id, ...approved }, actor);
  if (gate.kind === "ready" && outcome === "merged") {
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "merged", detail: { branch: review.branch, sha: gate.sha } }, actor);
    return true;
  }
  if (typeof outcome === "object" && outcome !== null && "split" in outcome) {
    // 設計書だけが入った。設計書は残し、コードは戻した。behind なら作った社員が rebase する (勤務時間外の社員は呼び出さない)
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "devloop_split", detail: { branch: review.branch, sha: gate.kind === "ready" ? gate.sha : null, to: outcome.split, code: outcome.code } }, actor);
    if (outcome.split === "todo" && made.assignee !== null) await notifyStaff(env, made.assignee, actor.now, false);
    return false;
  }
  if (gate.kind === "ready") {
    // main が先に進んでいた。例外にせず、遅れたリポジトリと一緒に作った社員に rebase を求める出来事を残し、勤務中なら次に取らせる (勤務時間外の社員は呼び出さない)
    const repo = typeof outcome === "object" && outcome !== null ? outcome.behind : review.repo;
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "main_advanced", detail: { branch: review.branch, sha: gate.sha, repo } }, actor);
    if (made.assignee !== null) await notifyStaff(env, made.assignee, actor.now, false);
    return false;
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

/** レビューのタスクを割り振る社員 */
export const REVIEWER: StaffId = "reviewer";

/** 定期の確かめが拾う、レビューのタスクの無いままレビューを待つタスクの古さ (10 分)。書く順の間にあるタスクを拾わない */
export const RECHECK_AFTER_MS = 10 * 60_000;

/** 定期の確かめが 1 回に立て直す数の上限 */
const RECHECK_LIMIT = 50;

/** レビュー担当に確かめを求める文と、足す行 */
export type AskReview = { row: NodeRow; statement: D1PreparedStatement };

/**
 * レビュー担当のレビューのタスクを足す、条件付きの 1 文を作る。書くのは呼ぶ側で、一緒に書く物と同じバッチに入れる
 * 確かめるタスクがレビューを待ち、同じプルリクエストに開いた (todo か doing の) レビューのタスクが無い時だけ足すので、同時に何度求めてもタスクは 1 つになる
 * @param env バインディング
 * @param made 確かめるタスク
 * @param pull 確かめるプルリクエスト
 * @param pull.repo リポジトリ
 * @param pull.branch ブランチ
 * @param pull.prNumber プルリクエストの番号
 * @param actor 誰がいつ
 * @param also ほかに足す条件。一緒に書く物と同じ条件を渡す
 * @returns 文と足す行。作った社員が分からないか、レビュー担当と同じモデルの時は、割り振れないので null
 */
export async function askReview(env: Bindings, made: NodeRow, pull: { repo: string; branch: string; prNumber: number; body?: string | null }, actor: Actor, also: SQL = sql`1`): Promise<AskReview | null> {
  try {
    if (made.assignee === null) throw new AppError("conflict", "作った社員が分からない");
    await checkPair(env.DB, made.assignee, REVIEWER);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    log("warn", "review_not_asked", { nodeId: made.id, reason: error.message });
    return null;
  }
  const row: NodeRow = {
    id: newId(clockAt(actor.now)),
    kind: "task",
    parentId: made.parentId,
    scope: made.scope,
    title: `レビュー: ${made.title}`,
    body: pull.body ?? null,
    taskKind: "review",
    assignee: REVIEWER,
    status: "todo",
    priority: made.priority,
    repo: pull.repo,
    branch: pull.branch,
    prNumber: pull.prNumber,
    issueNumber: null,
    source: "review",
    progress: null,
    version: 1,
    createdBy: actor.by,
    createdAt: actor.now,
    updatedAt: actor.now,
  };
  const when = sql`EXISTS (SELECT 1 FROM nodes WHERE id = ${made.id} AND status = 'review') AND NOT EXISTS (SELECT 1 FROM nodes WHERE repo = ${pull.repo} AND pr_number = ${pull.prNumber} AND task_kind = 'review' AND status IN ('todo', 'doing')) AND ${also}`;
  return { row, statement: insertWhenStatement(env.DB, nodes, row, when) };
}

/**
 * 求めた文で足せた時だけ、足したタスクの出来事と監査ログを残し、レビュー担当を呼ぶ。出来事は年ごとの記録の D1 にあり、同じバッチに入れられないので後で足す
 * @param env バインディング
 * @param asked askReview の文と行。null なら何もしない
 * @param result バッチの中のその文の結果
 * @param actor 誰がいつ
 * @returns 足せたか
 */
export async function reviewAsked(env: Bindings, asked: AskReview | null, result: D1Result | undefined, actor: Actor): Promise<boolean> {
  if (asked === null || (result?.meta.changes ?? 0) === 0) return false;
  await recordCreated(env, asked.row, actor);
  await notifyStaff(env, REVIEWER, actor.now, false);
  return true;
}

/**
 * 定期の確かめ。レビューを待ち、レビュー担当の判断が無く、開いたレビューのタスクも無いまま 10 分を過ぎたタスクに、レビューのタスクを立て直す
 * 求める文と同じバッチに入らない出来事と知らせの前に落ちた時の取りこぼしを拾う。10 分の猶予で、書く順の間にあるタスクを拾わない
 * @param env バインディング
 * @param now 今の時刻
 * @returns 立て直した数
 */
export async function recheckReviews(env: Bindings, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT n.id AS id, r.repo AS repo, r.branch AS branch, r.pr_number AS pr FROM nodes n JOIN reviews r ON r.node_id = n.id " +
      "WHERE n.status = 'review' AND n.task_kind <> 'review' AND n.updated_at < ? AND r.reviewer_verdict IS NULL " +
      "AND NOT EXISTS (SELECT 1 FROM nodes x WHERE x.repo = r.repo AND x.pr_number = r.pr_number AND x.task_kind = 'review' AND x.status IN ('todo', 'doing')) " +
      // レビューを割り振れない組 (作った社員とレビュー担当が同じモデル) は拾わない。拾っても askReview が断るだけで、上限の件数を食う
      "AND EXISTS (SELECT 1 FROM staff m JOIN staff v ON v.id = ? WHERE m.id = n.assignee AND m.model <> v.model) LIMIT ?",
  )
    .bind(now - RECHECK_AFTER_MS, REVIEWER, RECHECK_LIMIT)
    .all<{ id: string; repo: string; branch: string; pr: number }>();
  const actor: Actor = { by: "system", now };
  let added = 0;
  for (const found of results) {
    const made = await findNode(env.DB, found.id);
    // 読んだ後に動いたタスクは、今の版のままの時だけ足す
    const asked = await askReview(env, made, { repo: found.repo, branch: found.branch, prNumber: found.pr }, actor, sql`EXISTS (SELECT 1 FROM nodes WHERE id = ${made.id} AND version = ${made.version}) AND EXISTS (SELECT 1 FROM reviews WHERE node_id = ${made.id} AND reviewer_verdict IS NULL)`);
    if (asked === null) continue;
    const [result] = await env.DB.batch([asked.statement]);
    if (await reviewAsked(env, asked, result, actor)) added += 1;
  }
  return added;
}
