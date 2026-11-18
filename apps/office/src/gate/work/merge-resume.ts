// main に入れる途中で Worker が止まり、done のまま残ったタスクを定期の確かめで拾う (タスクとレビューの 3.1 の 5、開発の回し方の 3.6)
import type { Bindings } from "../env.ts";
import type { GuardDeps } from "../guard/deps.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "./attendance.ts";
import type { Forge } from "./loop.ts";
import { findNode } from "./nodes.ts";
import { mergeIfReady } from "./review.ts";

/** done にしてからこの時間が過ぎたタスクだけ拾う。入れている最中のタスクを、止まったと誤って戻さない猶予 */
export const RESUME_AFTER_MS = 10 * 60_000;

/** 1 回に拾う件数の上限。1 件ごとに GitHub を読むので、残りは次の 5 分に回す */
export const RESUME_LIMIT = 20;

/** 拾った 1 件 */
type Stopped = { id: string; version: number; repo: string; branch: string; pr: number; sha: string };

/**
 * done のまま main に入っていないタスクを拾う。確かめたコミットが main に入っていれば入った印だけを書き、入っていなければ review に戻して入れ直す
 * 戻す文はタスクが読んだ版のままの時だけ書き、同じバッチで未送信の閉じの順番待ちを消す。同時に拾っても戻せるのは 1 つだけ。入れ直しは承認とチェックを確かめ直す入口 (mergeIfReady) を通り、設計書だけが入っていればコードだけ進める
 * 1 件が落ちても残りを続け、落ちた物はエラーログに残して次の 5 分で拾い直す
 * @param env バインディング
 * @param forge GitHub
 * @param guard 自動停止が外へ頼む口
 * @param now 今の時刻
 * @returns 印を書いたか、戻したタスクの数
 */
export async function resumeMerges(env: Bindings, forge: Forge, guard: GuardDeps, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT n.id AS id, n.version AS version, r.repo AS repo, r.branch AS branch, r.pr_number AS pr, r.head_sha AS sha FROM nodes n JOIN reviews r ON r.node_id = n.id " +
      "WHERE n.status = 'done' AND n.task_kind <> 'review' AND r.merged_at IS NULL AND n.updated_at < ? ORDER BY n.updated_at, n.id LIMIT ?",
  )
    .bind(now - RESUME_AFTER_MS, RESUME_LIMIT)
    .all<Stopped>();
  let handled = 0;
  for (const found of results) {
    try {
      if (await resumeOne(env, forge, guard, found, now)) handled += 1;
    } catch (error) {
      await recordError(env, { source: "job", level: "error", code: "merge_resume_failed", error }, clockAt(now));
    }
  }
  return handled;
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
  await mergeIfReady(env, forge, made, { repo: found.repo, branch: found.branch, prNumber: found.pr, reviewer: null }, { staffId: null, kind: "merge_resumed", detail: { sha: found.sha } }, { by: "system", now }, guard, false);
  return true;
}
