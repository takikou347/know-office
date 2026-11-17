// know-office の中のレビューを GitHub のプルリクエストに写す。書く時に順番待ちに入れ、すぐに送り、送れなければエラーログに残して 5 分ごとに送り直す (タスクとレビューの 3.6)
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError, type Clock, MirrorCommentPayload, MirrorIssueClosePayload, MirrorReviewPayload, MirrorStatusPayload, newId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { settleParent } from "../devloop/release.ts";
import { noticeGitHubRateLimit } from "./limits.ts";
import { GitHubRateLimited } from "./rate-error.ts";
import type { Forge } from "../work/loop.ts";

/** 送る者の印の長さ (1 分)。GitHub の呼び出しの待ち時間 (10 秒) の数回分より長くし、落ちた者の印は次の回に外れる */
const CLAIM_MS = 60_000;
/** 送る回数の上限。5 分ごとに送り直すので、およそ 1 時間であきらめる */
export const MIRROR_ATTEMPTS = 12;
/** 1 回の送り直しで送る数の上限 */
const RETRY_BATCH = 20;

/** 写す物 1 つ。review は可か不可のレビュー、comment は行のコメント、status はオーナーの判断のコミットのステータス、issue_close は main に入った子 Issue の閉じ */
export type Mirror =
  | { kind: "review"; payload: MirrorReviewPayload }
  | { kind: "comment"; payload: MirrorCommentPayload }
  | { kind: "status"; payload: MirrorStatusPayload }
  | { kind: "issue_close"; payload: MirrorIssueClosePayload };

/** オーナーの判断から、出すステータス */
const VERDICT_STATE: Partial<Record<string, "success" | "failure">> = { approve: "success", request_changes: "failure" };

/** オーナーの判断のステータスに添える説明 */
const STATUS_DESCRIPTION = { success: "オーナーが承認した", failure: "オーナーが差し戻した" } as const;

/**
 * 順番待ちに 1 つ足す文を作る。写す元 (判断か指摘) と同じバッチに入れ、片方だけ残さない
 * @param env バインディング
 * @param reviewId レビュー ID
 * @param mirror 写す物
 * @param clock 時刻
 * @param when 足す条件。写す元を書く文と同じ条件を渡し、書けなかった時は足さない
 * @param when.sql 条件の SQL
 * @param when.args 条件の値
 * @returns 順番待ちの ID と、足す文
 */
export function enqueueMirror(env: Bindings, reviewId: string, mirror: Mirror, clock: Clock, when: { sql: string; args: unknown[] } = { sql: "1", args: [] }): { id: string; statement: D1PreparedStatement } {
  const id = newId(clock);
  const statement = env.DB.prepare(`INSERT INTO github_mirrors (id, review_id, kind, payload, created_at, attempts) SELECT ?, ?, ?, ?, ?, 0 WHERE ${when.sql}`).bind(
    id,
    reviewId,
    mirror.kind,
    JSON.stringify(mirror.payload),
    clock.now(),
    ...when.args,
  );
  return { id, statement };
}

/** 取った順番待ちの行と、写す先のプルリクエスト */
type Claimed = { id: string; kind: string; payload: string; attempts: number; repo: string | null; pr_number: number | null; head_sha: string | null; owner_verdict: string | null };

/**
 * 順番待ちの 1 つを GitHub に送る。送る者の印を 1 文で取れた時だけ送るので、同時に 2 つ走っても 1 度だけ送る
 * @param env バインディング
 * @param forge GitHub
 * @param id 順番待ちの ID
 * @param clock 時刻
 * @returns 送れたら sent、送れなければ failed、ほかの者が送る間か送り終えていれば skipped
 */
export async function sendMirror(env: Bindings, forge: Forge, id: string, clock: Clock): Promise<"sent" | "failed" | "skipped"> {
  const now = clock.now();
  const claim = now + CLAIM_MS;
  const row = await env.DB.prepare(
    `UPDATE github_mirrors SET claimed_until = ?, attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL AND attempts < ? AND (claimed_until IS NULL OR claimed_until <= ?)
     RETURNING review_id, kind, payload, attempts`,
  )
    .bind(claim, id, MIRROR_ATTEMPTS, now)
    .first<{ review_id: string; kind: string; payload: string; attempts: number }>();
  if (!row) return "skipped";
  const target = await env.DB.prepare("SELECT repo, pr_number, head_sha, owner_verdict FROM reviews WHERE id = ?")
    .bind(row.review_id)
    .first<{ repo: string; pr_number: number; head_sha: string; owner_verdict: string | null }>();
  const claimed: Claimed = { ...row, id, repo: target?.repo ?? null, pr_number: target?.pr_number ?? null, head_sha: target?.head_sha ?? null, owner_verdict: target?.owner_verdict ?? null };
  let githubId: number | null;
  try {
    githubId = await post(env, forge, claimed, clock.now());
  } catch (error) {
    if (error instanceof AppError && error.code === "rate_limited") {
      // GitHub の上限は送り方の誤りでないので回数に数えず、待つ時刻まで印を残して写し直しに取らせない。
      // 送る間に印が切れて別の者が取り直していれば、その者の印と数えを変えない
      const until = clock.now() + Number(error.headers["Retry-After"] ?? "60") * 1000;
      await env.DB.prepare("UPDATE github_mirrors SET claimed_until = ?, attempts = attempts - 1 WHERE id = ? AND sent_at IS NULL AND claimed_until = ?").bind(until, id, claim).run();
      await recordError(env, { source: "job", level: "warn", code: "github_mirror_rate_limited", error }, clock);
      // 写しもゲートウェイから GitHub への口なので、エラーログは写しの code のまま、レート制限の通知を出す
      await noticeGitHubRateLimit(env, clock, error instanceof GitHubRateLimited ? error.seconds : Number(error.headers["Retry-After"] ?? "60"));
      return "failed";
    }
    await env.DB.prepare("UPDATE github_mirrors SET claimed_until = NULL WHERE id = ? AND sent_at IS NULL").bind(id).run();
    const gaveUp = claimed.attempts >= MIRROR_ATTEMPTS;
    await recordError(env, { source: "job", level: gaveUp ? "error" : "warn", code: gaveUp ? "github_mirror_gave_up" : "github_mirror_failed", error }, clock);
    return "failed";
  }
  try {
    await env.DB.prepare("UPDATE github_mirrors SET github_id = ?, sent_at = ?, claimed_until = NULL WHERE id = ? AND sent_at IS NULL").bind(githubId, clock.now(), id).run();
  } catch (error) {
    // GitHub には写せたので、次の写し直しは本文の目印で見つけて送らずに印だけを置く
    await recordError(env, { source: "job", level: "warn", code: "github_mirror_unrecorded", error }, clock);
    return "failed";
  }
  return "sent";
}

/**
 * main に入った子 Issue を閉じ、dev_issues を closed にする。閉じるのは、積んだコミットを main が含む事を確かめてからで、main に入れる前に積んだ行が、入らなかった PR の Issue を閉じない。
 * 送る時の dev_issues の今を読み、開いている時だけ閉じる (理由は completed)。閉じた後は、親の子がすべて閉じていれば親も閉じる。設計書の変更で not_planned に閉じた Issue を completed で上書きしない。閉じている Issue をもう一度閉じても GitHub は成功を返すので、行を直す前に落ちても送り直せる
 * @param env バインディング
 * @param forge GitHub
 * @param repo リポジトリ
 * @param close 閉じる Issue の番号と、積んだコミット
 * @param now 今の時刻
 * @returns 常に null (GitHub の ID は無い)
 * @throws conflict 積んだコミットがまだ main に入っていない時
 * @throws upstream_failed GitHub が失敗を返した時
 */
async function closeIssue(env: Bindings, forge: Forge, repo: string, close: MirrorIssueClosePayload, now: number): Promise<null> {
  if (!(await forge.inMain(repo, close.sha))) throw new AppError("conflict", "積んだコミットがまだ main に入っていない");
  const row = await env.DB.prepare("SELECT state FROM dev_issues WHERE repo = ? AND number = ?").bind(repo, close.issueNumber).first<{ state: string }>();
  if (row === null) return null;
  if (row.state === "open") {
    await forge.issues.close(repo, close.issueNumber, "completed");
    await env.DB.prepare("UPDATE dev_issues SET state = 'closed', closed_at = ?, close_reason = 'completed' WHERE repo = ? AND number = ? AND state = 'open'").bind(now, repo, close.issueNumber).run();
  }
  // 閉じた後 (送り直しで閉じていた時も) 親の子がすべて閉じていれば親を閉じる。親が閉じられなければここで落ち、順番待ちが送り直す
  await settleParent(env, forge.issues, repo, close.issueNumber, now);
  return null;
}

/**
 * 順番待ちの ID から、写す本文の末尾に付ける見えない目印を作る。GitHub の画面では HTML のコメントとして隠れる
 * @param id 順番待ちの ID
 * @returns 目印
 */
export function mirrorMarker(id: string): string {
  return `<!-- know-office:mirror:${id} -->`;
}

/**
 * 取った行の中身を形で確かめ、本文の末尾に目印を付けて GitHub に送る
 * 2 回目からは、前の回が GitHub に送れた後に印を書けずに落ちたかもしれないので、先に GitHub の一覧で目印を探し、あればその ID を返して送らない
 * @param env バインディング
 * @param forge GitHub
 * @param claimed 取った行
 * @param now 今の時刻
 * @returns GitHub のレビューかコメントかステータスの ID。出す物が無くなったステータスと、子 Issue の閉じは null
 * @throws Error 中身の形が違う時、レビューが無い時
 * @throws conflict 子 Issue の閉じで、積んだコミットがまだ main に入っていない時
 * @throws upstream_failed GitHub が失敗を返した時、一覧を読み切れない時
 */
async function post(env: Bindings, forge: Forge, claimed: Claimed, now: number): Promise<number | null> {
  if (claimed.repo === null || claimed.pr_number === null) throw new Error("写す先のレビューが無い");
  const raw: unknown = JSON.parse(claimed.payload);
  if (claimed.kind === "issue_close") return closeIssue(env, forge, claimed.repo, MirrorIssueClosePayload.parse(raw), now);
  // ステータスは同じ sha と名前なら GitHub が最後に受けた物を今の値にする。出し直しが後の判断より遅れて届いても今の判断に合うよう、
  // 積んだ時の判断でなく送る時のレビューの判断を出し、先が進んだか判断が消えていれば出さない
  if (claimed.kind === "status") {
    const status = MirrorStatusPayload.parse(raw);
    const state = VERDICT_STATE[claimed.owner_verdict ?? ""];
    if (claimed.head_sha !== status.commitId || state === undefined) return null;
    return forge.postStatus(claimed.repo, status.commitId, { state, description: STATUS_DESCRIPTION[state] });
  }
  const marker = mirrorMarker(claimed.id);
  const kind = claimed.kind === "review" ? "review" : "comment";
  if (claimed.attempts > 1) {
    const found = await forge.findMirror(claimed.repo, claimed.pr_number, kind, marker);
    if (found !== null) return found;
  }
  if (kind === "review") {
    const review = MirrorReviewPayload.parse(raw);
    return forge.postReview(claimed.repo, claimed.pr_number, { ...review, body: `${review.body}\n\n${marker}` });
  }
  const comment = MirrorCommentPayload.parse(raw);
  return forge.postComment(claimed.repo, claimed.pr_number, { ...comment, body: `${comment.body}\n\n${marker}` });
}

/**
 * 送れていない順番待ちを古い順に送り直す。5 分ごとの定期ジョブが呼ぶ
 * @param env バインディング
 * @param forge GitHub
 * @param clock 時刻
 * @returns 送れた数と、送れなかった数
 */
export async function retryMirrors(env: Bindings, forge: Forge, clock: Clock): Promise<{ sent: number; failed: number }> {
  const now = clock.now();
  const { results } = await env.DB.prepare("SELECT id FROM github_mirrors WHERE sent_at IS NULL AND attempts < ? AND (claimed_until IS NULL OR claimed_until <= ?) ORDER BY id LIMIT ?")
    .bind(MIRROR_ATTEMPTS, now, RETRY_BATCH)
    .all<{ id: string }>();
  const out = { sent: 0, failed: 0 };
  for (const { id } of results) {
    const result = await sendMirror(env, forge, id, clock);
    if (result === "sent") out.sent += 1;
    else if (result === "failed") out.failed += 1;
  }
  return out;
}
