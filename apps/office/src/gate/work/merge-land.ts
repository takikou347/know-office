// 確かめた先を main に入れ、入れたか戻したかを出来事に残す。承認、チェックの通知、定期の拾い直しが共に使う (タスクとレビューの 3.1 の 5)
import { AppError, log } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { type Forge, notifyStaff } from "./loop.ts";
import type { Landed } from "./docs-merge.ts";
import { mergeMade } from "./merge-made.ts";
import { type Actor, appendNodeEvent, type NodeRow } from "./nodes.ts";
import type { MergeGate } from "./review.ts";

/** 定期の拾い直しが入れ損ねた行を試す間 (10 分)。merge-resume.ts の RESUME_AFTER_MS と同じ長さ */
export const RETRY_AFTER_MS = 10 * 60_000;

/** 入れた結果。merged は入れた、back は入れずに戻した (main が先に進んだか設計書だけ入った)、taken はほかの入口が先に入れ始めたか、読んだ後に行が変わった */
export type LandResult = "merged" | "back" | "taken";

/**
 * 入れ損ねた review の行に、定期の拾い直しの印 (次に試す時刻と、試す先) を書く。入れ始めた印のある行 (入れている最中か done のまま止まった物) には書かない
 * @param env バインディング
 * @param nodeId 作った社員のタスク ID
 * @param sha 試す先
 * @param at 次に試す時刻。もう試す時刻があれば変えない
 */
export async function markRetry(env: Bindings, nodeId: string, sha: string, at: number): Promise<void> {
  await env.DB.prepare("UPDATE reviews SET merge_retry_at = COALESCE(merge_retry_at, ?), merge_started_sha = ? WHERE node_id = ? AND merge_started_at IS NULL").bind(at, sha, nodeId).run();
}

/**
 * 拾い直しの印を消し、失敗の回数を 0 に戻す。投げずに終えた (入れた、待つ、断った) 行に使う。入れ始めた印のある行は触らない
 * @param env バインディング
 * @param nodeId 作った社員のタスク ID
 */
export async function clearRetry(env: Bindings, nodeId: string): Promise<void> {
  await env.DB.prepare("UPDATE reviews SET merge_retry_at = NULL, merge_started_sha = NULL, merge_tries = 0 WHERE node_id = ? AND merge_started_at IS NULL").bind(nodeId).run();
}

/**
 * mergeGate が ready と答えたタスクを main に入れ、入れたか戻したかを出来事に残す
 * main を進める所で投げた時は、タスクは review に戻っているので、拾い直しの印と出来事 merge_failed を残してから投げ直す。ほかの入口が先に done にした時と、読んだ後にレビューの行が変わった時は何もしない
 * @param env バインディング
 * @param forge GitHub
 * @param made 確かめたタスク
 * @param review リポジトリとブランチ
 * @param review.repo リポジトリ
 * @param review.branch ブランチ
 * @param gate mergeGate の答え
 * @param actor 誰がいつ
 * @returns 入れたか、戻したか、先を越されたか
 * @throws upstream_failed GitHub が main を進める更新を断った時
 */
export async function landReady(env: Bindings, forge: Forge, made: NodeRow, review: { repo: string; branch: string }, gate: Extract<MergeGate, { kind: "ready" }>, actor: Actor): Promise<LandResult> {
  let outcome: Landed;
  try {
    outcome = await mergeMade(env, forge, made, { repo: review.repo, branch: review.branch, sha: gate.sha, docs: gate.docs, seen: gate.seen }, actor.now);
  } catch (error) {
    if (error instanceof AppError && error.code === "conflict") {
      log("info", "merge_taken", { nodeId: made.id });
      return "taken";
    }
    await markRetry(env, made.id, gate.sha, actor.now + RETRY_AFTER_MS);
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "merge_failed", detail: { sha: gate.sha, code: error instanceof AppError ? error.code : "internal" } }, actor);
    throw error;
  }
  if (outcome === "merged") {
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "merged", detail: { branch: review.branch, sha: gate.sha } }, actor);
    return "merged";
  }
  if ("split" in outcome) {
    // 設計書だけが入った。設計書は残し、コードは戻した。behind なら作った社員が rebase する (勤務時間外の社員は呼び出さない)
    await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "devloop_split", detail: { branch: review.branch, sha: gate.sha, to: outcome.split, code: outcome.code } }, actor);
    if (outcome.split === "todo" && made.assignee !== null) await notifyStaff(env, made.assignee, actor.now, false);
    return "back";
  }
  // main が先に進んでいた。例外にせず、遅れたリポジトリと一緒に作った社員に rebase を求める出来事を残し、勤務中なら次に取らせる (勤務時間外の社員は呼び出さない)
  await appendNodeEvent(env, { nodeId: made.id, staffId: null, kind: "main_advanced", detail: { branch: review.branch, sha: gate.sha, repo: outcome.behind } }, actor);
  if (made.assignee !== null) await notifyStaff(env, made.assignee, actor.now, false);
  return "back";
}
