// 承認の後にチェックを待つタスクを、チェックの終わりの通知と定期の拾い直しで main に入れる。落ちた時はオーナーに 1 回だけ知らせる (タスクとレビューの 3.1 の 5)
import { newId, StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { noticeGitHubRateLimit } from "../github/limits.ts";
import { GitHubRateLimited } from "../github/rate-error.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { observe } from "../guard/observe.ts";
import { recordError } from "../ledger/errors.ts";
import { announceNotice } from "../live/publish.ts";
import { clockAt } from "./attendance.ts";
import type { Forge } from "./loop.ts";
import { clearRetry, landReady, RETRY_AFTER_MS } from "./merge-land.ts";
import { type Actor, appendNodeEvent, findNode, type NodeRow } from "./nodes.ts";
import { mergeGate } from "./review.ts";

/** 通知の応答の中で確かめる件数。GitHub は 10 秒で通知を切るので、残りは定期の拾い直しに任せる */
export const INLINE_LIMIT = 5;

/** チェックが落ちた時の知らせの本文。社員の書いた文は入れない */
const FAILED_BODY = "承認の後にチェックが落ちたので、main に入れていない。レビューの画面で差し戻すか、チェックを走らせ直す";

/** 確かめるレビューの行 */
export type ApprovedRow = { id: string; repo: string; branch: string; pr: number };

/**
 * 承認のある review のタスクを 1 つ確かめ、そろっていれば入れる。待つ時と断る時は何も書かない。チェックが落ちていれば、自動停止に数えず review のまま、同じ先ごとに 1 回だけ出来事とオーナーへの知らせを出す
 * 投げずに終えたら、拾い直しの印を消す
 * @param env バインディング
 * @param forge GitHub
 * @param guard 自動停止が外へ頼む口
 * @param made 確かめるタスク
 * @param row レビューの行のリポジトリ、ブランチ、プルリクエストの番号
 * @param actor 誰がいつ
 * @param options 名前付きの指定
 * @param options.counted 入れる時にマージの求めとして自動停止に数えるか。定期の拾い直しは社員の求めでないので false
 * @returns 入れたか
 * @throws upstream_failed GitHub から読めないか、main を進められない時 (拾い直しの印は残る)
 */
export async function settleApproved(env: Bindings, forge: Forge, guard: GuardDeps, made: NodeRow, row: ApprovedRow, actor: Actor, options: { counted: boolean }): Promise<boolean> {
  // 読んだ後に差し戻されたか終えたタスクは入れない。done にする文はこの版の時だけ書くので、この後に動いた物も入れない
  if (made.status !== "review") {
    await clearRetry(env, made.id);
    return false;
  }
  const gate = await mergeGate(env, forge, made, { repo: row.repo, branch: row.branch, prNumber: row.pr, reviewer: null });
  let merged = false;
  if (gate.kind === "ready") {
    // 入れる時はマージの求めとして自動停止に渡す (3.4)。落ちたチェックは求めた時に走っていたので、社員の求めとして数えない
    const maker = StaffId.safeParse(made.assignee);
    if (options.counted && maker.success) await observe(env, { type: "merge_requested", staffId: maker.data, nodeId: made.id, checksPassed: true }, actor.now, guard, actor.traceId);
    merged = (await landReady(env, forge, made, row, gate, actor)) === "merged";
  } else if (gate.kind === "failed") {
    await checksFailed(env, made, actor);
  }
  await clearRetry(env, made.id);
  return merged;
}

/**
 * チェックが落ちた事を、同じタスクと先ごとに 1 回だけ、オーナーへの知らせとタスクの出来事に残す。読んだ後も同じ題は足さない
 * @param env バインディング
 * @param made 確かめたタスク
 * @param actor 誰がいつ
 */
async function checksFailed(env: Bindings, made: NodeRow, actor: Actor): Promise<void> {
  const head = await env.DB.prepare("SELECT head_sha AS sha FROM reviews WHERE node_id = ?").bind(made.id).first<{ sha: string }>();
  const sha = head?.sha ?? "";
  const id = newId(clockAt(actor.now));
  const title = `承認の後にチェックが落ちた (${made.id.slice(0, 8)} ${sha.slice(0, 8)})`;
  const added = await env.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) SELECT ?1, ?2, 'warn', 'checks_failed', ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM notices WHERE kind = 'checks_failed' AND title = ?3)")
    .bind(id, actor.now, title, FAILED_BODY, made.scope)
    .run();
  if (added.meta.changes === 0) return;
  await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "checks_failed", detail: { sha } }, actor);
  await announceNotice(env, id, clockAt(actor.now));
}

/** 通知の先を確かめた、承認のある review のタスクを探す条件。?1 はリポジトリ、?2 は先。設計書の PR の先も見る */
const APPROVED_AT =
  "n.status = 'review' AND n.task_kind <> 'review' AND (r.reviewer_verdict = 'approve' OR r.owner_verdict = 'approve') " +
  "AND ((r.repo = ?1 AND r.head_sha = ?2) OR (r.docs_head_sha = ?2 AND EXISTS (SELECT 1 FROM task_docs d WHERE d.node_id = n.id AND d.repo = ?1)))";

/**
 * チェックの終わりの通知を受けた後に、その先を確かめた承認のある review のタスクを main に入れる
 * 確かめる前に、拾った行すべてに定期の拾い直しの印 (10 分後) を書くので、ここで確かめない行と途中で落ちた行は定期の拾い直しが拾う。応答の中で確かめるのは INLINE_LIMIT 件まで
 * 1 件が投げても残りを続け、エラーログに残す。GitHub のレート制限に当たったら、そこで止めて通知に任せる
 * @param env バインディング
 * @param forge GitHub
 * @param guard 自動停止が外へ頼む口
 * @param target 通知のリポジトリと先
 * @param target.repo リポジトリ
 * @param target.sha 先
 * @param now 今の時刻
 * @returns 入れた数
 */
export async function mergeAfterChecks(env: Bindings, forge: Forge, guard: GuardDeps, target: { repo: string; sha: string }, now: number): Promise<number> {
  await env.DB.prepare(
    `UPDATE reviews SET merge_retry_at = ?3, merge_started_sha = head_sha WHERE merge_started_at IS NULL AND merge_retry_at IS NULL AND node_id IN (SELECT n.id FROM nodes n JOIN reviews r ON r.node_id = n.id WHERE ${APPROVED_AT})`,
  )
    .bind(target.repo, target.sha, now + RETRY_AFTER_MS)
    .run();
  const { results } = await env.DB.prepare(`SELECT n.id AS id, r.repo AS repo, r.branch AS branch, r.pr_number AS pr FROM nodes n JOIN reviews r ON r.node_id = n.id WHERE ${APPROVED_AT} ORDER BY n.id LIMIT ?3`)
    .bind(target.repo, target.sha, INLINE_LIMIT)
    .all<ApprovedRow>();
  const actor: Actor = { by: "github", now };
  let merged = 0;
  for (const row of results) {
    try {
      if (await settleApproved(env, forge, guard, await findNode(env.DB, row.id), row, actor, { counted: true })) merged += 1;
    } catch (error) {
      if (error instanceof GitHubRateLimited) {
        await noticeGitHubRateLimit(env, clockAt(now), error.seconds);
        break;
      }
      await recordError(env, { source: "gate", level: "warn", code: "merge_after_checks_failed", error }, clockAt(now));
    }
  }
  return merged;
}
