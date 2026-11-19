// GitHub の画面でオーナーが出した可と不可、行のコメントの通知を受け、know-office のレビューと作った社員のタスクに写す (タスクとレビューの 3.2、GitHub の連携の 3.4)
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError, log, newId, PullRequestReviewCommentEvent, PullRequestReviewEvent } from "@know-office/core";
import type { Bindings } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import type { Forge } from "../work/loop.ts";
import { markRetry, RETRY_AFTER_MS } from "../work/merge-land.ts";
import { type Actor, appendNodeEvent, findNode } from "../work/nodes.ts";
import { backToTodo, callMaker, mergeIfReady } from "../work/review.ts";
import type { GitHubLink } from "./app.ts";

/** レビューの通知のうち使う所 */
export type ReviewHook = { digest: string; event: string; action: string | null; repo: string | null; payload: unknown; link: GitHubLink; now: number };

/** GitHub のレビューの状態から know-office の判断。コメントだけのレビューと取り下げは写さない */
const REVIEW_STATES: ReadonlyMap<string, "approve" | "request_changes"> = new Map([
  ["approved", "approve"],
  ["changes_requested", "request_changes"],
]);

/** GitHub から写す、オーナーの可か不可か、行のコメント */
type FromGitHub =
  | { kind: "review"; githubId: number; pr: number; verdict: "approve" | "request_changes"; body: string; commitId: string }
  | { kind: "comment"; githubId: number; pr: number; path: string; line: number; side: "old" | "new"; body: string };

/**
 * GitHub の利用者が、写してよいオーナーかを返す。App が写した物 (App のボット) と、持ち主でない者の物は写さない
 * 公開のリポジトリには誰でもレビューを書けるので、持ち主の印 (author_association が OWNER) の無い物でタスクを動かさない
 * @param hook 確かめた通知
 * @param user 書いた者
 * @param association 書いた者とリポジトリの関わり
 * @returns 写してよければ true
 */
function byOwner(hook: ReviewHook, user: { login: string; type: string } | null, association: string): boolean {
  if (!user || user.type === "Bot") return false;
  if (hook.link.app && user.login === `${hook.link.app.slug}[bot]`) return false;
  return association === "OWNER";
}

/**
 * 通知から、写すオーナーのレビューか行のコメントを読む
 * @param hook 確かめた通知
 * @returns 写す物。写さない通知なら null
 */
function fromGitHub(hook: ReviewHook): FromGitHub | null {
  if (hook.event === "pull_request_review" && hook.action === "submitted") {
    const parsed = PullRequestReviewEvent.safeParse(hook.payload);
    if (!parsed.success) return null;
    const { review, pull_request: pull } = parsed.data;
    if (!byOwner(hook, review.user, review.author_association)) return null;
    const verdict = REVIEW_STATES.get(review.state);
    if (verdict === undefined) return null;
    return { kind: "review", githubId: review.id, pr: pull.number, verdict, body: review.body ?? "", commitId: review.commit_id };
  }
  if (hook.event === "pull_request_review_comment" && hook.action === "created") {
    const parsed = PullRequestReviewCommentEvent.safeParse(hook.payload);
    if (!parsed.success) return null;
    const { comment, pull_request: pull } = parsed.data;
    // 古い差分に付いて行の無いコメントは、行の指摘として置けない
    if (!byOwner(hook, comment.user, comment.author_association) || comment.line === null || comment.line === undefined) return null;
    return { kind: "comment", githubId: comment.id, pr: pull.number, path: comment.path, line: comment.line, side: comment.side === "LEFT" ? "old" : "new", body: comment.body };
  }
  return null;
}

/**
 * オーナーが GitHub の画面で出した可と不可、行のコメントを know-office のレビューに写す (GitHub の連携の 3.4、タスクとレビューの 3.2)
 * know-office が写した物の通知は写し返さない。受けた記録を先に 1 文で取り、取れた側だけが写す。写せなければ記録を消し、GitHub の送り直しで受け直す
 * @param env バインディング
 * @param hook 確かめた通知
 * @param record 受けた記録を書く文
 * @param ctx GitHub を呼ぶ口と、自動停止が外へ頼む口。オーナーの可で main に入れるのに使う
 * @param ctx.forge GitHub を呼ぶ口
 * @param ctx.guard 自動停止が外へ頼む口
 */
export async function intakeReview(env: Bindings, hook: ReviewHook, record: D1PreparedStatement, ctx: { forge: Forge; guard: GuardDeps }): Promise<void> {
  const found = fromGitHub(hook);
  const review =
    found && hook.repo !== null
      ? await env.DB.prepare("SELECT id, node_id, repo, branch, pr_number FROM reviews WHERE repo = ? AND pr_number = ?").bind(hook.repo, found.pr).first<ReviewOf>()
      : null;
  if (!found || !review) {
    await record.run();
    return;
  }
  const taken = await record.run();
  if (taken.meta.changes === 0) return;
  try {
    await applyFromGitHub(env, found, review, hook.now, ctx);
  } catch (error) {
    await env.DB.prepare("DELETE FROM github_deliveries WHERE body_sha256 = ?").bind(hook.digest).run();
    throw error;
  }
}

/** 写す先のレビューの行 */
type ReviewOf = { id: string; node_id: string; repo: string; branch: string; pr_number: number };

/**
 * GitHub で出たオーナーの可を出来事に残し、タスクがレビューを待っていて main に入れる条件がそろえば入れる。画面の可 (routes/reviews.ts) と同じ入口を通る
 * 確かめの途中か main を進める所で落ちても投げない。可は写せているので、拾い直しの印を残して定期の拾い直しに任せる
 * @param env バインディング
 * @param ctx GitHub を呼ぶ口と、自動停止が外へ頼む口
 * @param ctx.forge GitHub を呼ぶ口
 * @param ctx.guard 自動停止が外へ頼む口
 * @param review 写したレビューの行
 * @param event 可の出来事
 * @param event.detail 出来事の中身
 * @param event.key 出来事の鍵。同じ GitHub のレビューを受け直しても 1 行にする
 * @param event.actor 出来事の誰といつ。いつは、そのレビューを最初に受けた時刻
 * @param actor 誰がいつ
 */
async function ownerApproved(
  env: Bindings,
  ctx: { forge: Forge; guard: GuardDeps },
  review: ReviewOf,
  event: { detail: Record<string, unknown>; key: string; actor: Actor },
  actor: Actor,
): Promise<void> {
  // 可の出来事は入れる前に 1 度だけ残す。入れる所の確かめで GitHub を読めなくても、可は残る
  await appendNodeEvent(env, { nodeId: review.node_id, staffId: null, kind: "owner_approved", detail: event.detail, key: event.key }, event.actor);
  const made = await findNode(env.DB, review.node_id);
  if (made.status !== "review") return;
  try {
    await mergeIfReady(env, ctx.forge, made, { repo: review.repo, branch: review.branch, prNumber: review.pr_number, reviewer: null }, null, actor, ctx.guard);
  } catch (error) {
    // GitHub は通知を送り直さないので、確かめの途中で落ちた物も定期の拾い直しに任せる
    const head = await env.DB.prepare("SELECT head_sha AS sha FROM reviews WHERE node_id = ?").bind(review.node_id).first<{ sha: string }>();
    if (head !== null) await markRetry(env, review.node_id, head.sha, actor.now + RETRY_AFTER_MS);
    await recordError(env, { source: "gate", level: "warn", code: "owner_merge_failed", error }, clockAt(actor.now));
  }
}

/**
 * 写す物をレビューに置き、作った社員のタスクの出来事に足す。不可と行のコメントはタスクを todo に戻す
 * 判断か指摘と、todo に戻す事は 1 回のバッチで書く。出来事はその後に足し、最後に担当の社員を呼ぶ
 * @param env バインディング
 * @param found 写す物
 * @param review レビューの ID と、作った社員のタスク ID
 * @param review.id レビュー ID
 * @param review.node_id 作った社員のタスク ID
 * @param review.repo リポジトリ
 * @param review.branch ブランチ
 * @param review.pr_number プルリクエストの番号
 * @param now 今の時刻
 * @param ctx GitHub を呼ぶ口と、自動停止が外へ頼む口
 * @param ctx.forge GitHub を呼ぶ口
 * @param ctx.guard 自動停止が外へ頼む口
 */
async function applyFromGitHub(env: Bindings, found: FromGitHub, review: ReviewOf, now: number, ctx: { forge: Forge; guard: GuardDeps }): Promise<void> {
  const db = env.DB;
  const actor: Actor = { by: "github", now };
  if (found.kind === "review") {
    // レビューしたコミットがレビューの今の先の時だけ写す。古い先へのレビューを、新しい先の判断にしない
    const current = { sql: "EXISTS (SELECT 1 FROM reviews WHERE id = ? AND head_sha = ?)", args: [review.id, found.commitId] };
    const statements = [
      db.prepare("UPDATE reviews SET owner_verdict = ? WHERE id = ? AND head_sha = ?").bind(found.verdict, review.id, found.commitId),
      // 最初に受けた時刻を GitHub のレビュー 1 つに 1 行だけ残す。送り直しは配信 ID も時刻も変わるが、この行は変わらない
      db.prepare(`INSERT INTO github_reviews (github_review_id, received_at) SELECT ?, ? WHERE ${current.sql} ON CONFLICT (github_review_id) DO NOTHING`).bind(found.githubId, now, ...current.args),
    ];
    if (found.verdict === "request_changes") statements.push(backToTodo(db, review.node_id, now, current));
    const [updated] = await db.batch(statements);
    if ((updated?.meta.changes ?? 0) === 0) {
      log("info", "github_review_stale", { reviewId: review.id, githubReviewId: found.githubId });
      return;
    }
    // 出来事の node_events は年ごとの記録の D1 にあり、D1 のバッチは 1 つの D1 の中だけなので、同じバッチに入れられない
    // 鍵を GitHub のレビュー ID、時刻を最初に受けた時刻にして、送り直しでも、途中で落ちた後の受け直しでも同じ ID の 1 行にする
    const first = await db.prepare("SELECT received_at AS at FROM github_reviews WHERE github_review_id = ?").bind(found.githubId).first<{ at: number }>();
    if (first === null) throw new AppError("internal", "写した GitHub のレビューの行が無い");
    const event = { key: `github_review:${review.node_id}:${String(found.githubId)}`, actor: { by: "github", now: first.at } satisfies Actor };
    const detail = { by: "owner", summary: found.body, githubReviewId: found.githubId };
    if (found.verdict === "request_changes") {
      await appendNodeEvent(env, { nodeId: review.node_id, staffId: null, kind: "review_rejected", detail, key: event.key }, event.actor);
      await callMaker(env, review.node_id, now);
      return;
    }
    await ownerApproved(env, ctx, review, { detail, key: event.key, actor: event.actor }, actor);
    return;
  }
  const id = newId(clockAt(now));
  // 同じコメントを配信 ID を替えて 2 度受けても、指摘は 1 つ。タスクは、この指摘を足せた時だけ戻す
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO review_notes (id, review_id, at, by, path, line, side, body, github_comment_id) SELECT ?, ?, ?, 'owner', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM review_notes WHERE github_comment_id = ?)")
      .bind(id, review.id, now, found.path, found.line, found.side, found.body, found.githubId, found.githubId),
    backToTodo(db, review.node_id, now, { sql: "EXISTS (SELECT 1 FROM review_notes WHERE id = ?)", args: [id] }),
  ]);
  if ((inserted?.meta.changes ?? 0) === 0) return;
  await appendNodeEvent(env, { nodeId: review.node_id, staffId: null, kind: "review_note", detail: { by: "owner", noteId: id, path: found.path, line: found.line, side: found.side, body: found.body, githubCommentId: found.githubId } }, actor);
  await callMaker(env, review.node_id, now);
}
