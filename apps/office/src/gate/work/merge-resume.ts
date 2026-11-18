// main に入れる途中で Worker が止まり、done のまま残ったタスクを定期の確かめで拾う (タスクとレビューの 3.1 の 5、開発の回し方の 3.6)
import type { Bindings } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { noticeGitHubRateLimit } from "../github/limits.ts";
import { GitHubRateLimited } from "../github/rate-error.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "./attendance.ts";
import type { Forge } from "./loop.ts";
import { findNode } from "./nodes.ts";
import { noticeOnce } from "./notice.ts";
import { mergeIfReady } from "./review.ts";

/** done にしてからこの時間が過ぎたタスクだけ拾う。入れている最中のタスクを、止まったと誤って戻さない猶予 */
export const RESUME_AFTER_MS = 10 * 60_000;

/** 1 回に拾う件数の上限。1 件ごとに GitHub を読むので、残りは次の 5 分に回す */
export const RESUME_LIMIT = 20;

/** 定期の入れ直しを諦める失敗の回数。落ち続ける行が GitHub を叩き続けないようにする */
export const RESUME_TRIES = 5;

/** 拾った 1 件 */
type Stopped = { id: string; version: number; repo: string; branch: string; pr: number; sha: string };

/**
 * main に入れ始めたまま止まったタスクを拾う。拾うのは、mergeMade が done にする文と同じバッチで入れ始めた印を書いた物 (入れ始めた時のコミットが今の head_sha と同じ) だけで、印の無い done (社員が終えた物や、差し戻しの後に終えた物) は拾わない
 * 確かめたコミットが main に入っていれば入った印だけを書き、入っていなければ review に戻して入れ直す。戻す文はタスクが読んだ版のままの時だけ書き、同じバッチで未送信の閉じの順番待ちを消す。同時に拾っても戻せるのは 1 つだけ。入れ直しは承認とチェックを確かめ直す入口 (mergeIfReady) を通り、設計書だけが入っていればコードだけ進める
 * 1 件が落ちても残りを続ける。落ちた行は試す時刻を後ろへ回して回数を数え、RESUME_TRIES 回で諦めてエラーログと通知に 1 回だけ残す。GitHub のレート制限に当たったら、そこで止めて通知に任せる
 * @param env バインディング
 * @param forge GitHub
 * @param guard 自動停止が外へ頼む口
 * @param now 今の時刻
 * @returns 印を書いたか、戻したタスクの数
 */
export async function resumeMerges(env: Bindings, forge: Forge, guard: GuardDeps, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT n.id AS id, n.version AS version, r.repo AS repo, r.branch AS branch, r.pr_number AS pr, r.head_sha AS sha FROM nodes n JOIN reviews r ON r.node_id = n.id " +
      "WHERE n.status = 'done' AND n.task_kind <> 'review' AND r.merge_started_at IS NOT NULL AND r.merged_at IS NULL AND r.merge_started_sha = r.head_sha " +
      "AND n.updated_at < ? AND (r.merge_retry_at IS NULL OR r.merge_retry_at <= ?) ORDER BY COALESCE(r.merge_retry_at, r.merge_started_at), n.id LIMIT ?",
  )
    .bind(now - RESUME_AFTER_MS, now, RESUME_LIMIT)
    .all<Stopped>();
  let handled = 0;
  for (const found of results) {
    try {
      if (await resumeOne(env, forge, guard, found, now)) handled += 1;
    } catch (error) {
      if (error instanceof GitHubRateLimited) {
        await noticeGitHubRateLimit(env, clockAt(now), error.seconds);
        break;
      }
      await failed(env, found, error, now);
    }
  }
  return handled;
}

/**
 * 落ちた 1 件の試す時刻を後ろへ回し、RESUME_TRIES 回目なら諦める。諦めた行は拾わなくなり、エラーログと通知を 1 回だけ残す
 * @param env バインディング
 * @param found 落ちた物
 * @param error 投げられた物
 * @param now 今の時刻
 */
async function failed(env: Bindings, found: Stopped, error: unknown, now: number): Promise<void> {
  const row = await env.DB.prepare("UPDATE reviews SET merge_tries = merge_tries + 1, merge_retry_at = ? + (merge_tries + 1) * ? WHERE node_id = ? RETURNING merge_tries AS tries")
    .bind(now, RESUME_AFTER_MS, found.id)
    .first<{ tries: number }>();
  const gaveUp = (row?.tries ?? 0) >= RESUME_TRIES;
  if (gaveUp) {
    await env.DB.prepare("UPDATE reviews SET merge_started_at = NULL WHERE node_id = ?").bind(found.id).run();
    await noticeOnce(env, { kind: "merge_resume_gave_up", title: `main への入れ直しを諦めた (${found.id.slice(0, 8)})`, body: "止まったタスクの入れ直しが続けて落ちた。タスクは done のまま残っている。オーナーが確かめる" }, now);
  }
  await recordError(env, { source: "job", level: "error", code: gaveUp ? "merge_resume_gave_up" : "merge_resume_failed", error }, clockAt(now));
}

/**
 * 止まった 1 件を拾う。入れ直す前に GitHub の main が確かめたコミットを含むかを読む
 * @param env バインディング
 * @param forge GitHub
 * @param guard 自動停止が外へ頼む口
 * @param found 拾った物
 * @param now 今の時刻
 * @returns 印を書いたか戻した時 true。ほかの拾いに先を越された時 false
 * @throws upstream_failed GitHub から読めない時
 */
async function resumeOne(env: Bindings, forge: Forge, guard: GuardDeps, found: Stopped, now: number): Promise<boolean> {
  if (await forge.inMain(found.repo, found.sha)) {
    // 入れた後に印を書く前に止まった。閉じの順番待ちは、main に入った事を確かめて送る定期の送り直しに任せる
    const [marked] = await env.DB.batch([env.DB.prepare("UPDATE reviews SET merged_at = ? WHERE node_id = ? AND merged_at IS NULL").bind(now, found.id)]);
    return (marked?.meta.changes ?? 0) > 0;
  }
  // 戻す文と閉じの順番待ちを消す文は、同じバッチ。戻せなかった (別の拾いが先に戻した) 時は消さない
  const [back] = await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET status = 'review', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'done'").bind(now, found.id, found.version),
    env.DB.prepare(
      "DELETE FROM github_mirrors WHERE kind = 'issue_close' AND sent_at IS NULL AND review_id IN (SELECT id FROM reviews WHERE node_id = ?1) AND EXISTS (SELECT 1 FROM nodes WHERE id = ?1 AND version = ?2 AND status = 'review')",
    ).bind(found.id, found.version + 1),
  ]);
  if ((back?.meta.changes ?? 0) === 0) return false;
  const made = await findNode(env.DB, found.id);
  await mergeIfReady(env, forge, made, { repo: found.repo, branch: found.branch, prNumber: found.pr, reviewer: null }, { staffId: null, kind: "merge_resumed", detail: { sha: found.sha } }, { by: "system", now }, guard, { counted: false });
  return true;
}
