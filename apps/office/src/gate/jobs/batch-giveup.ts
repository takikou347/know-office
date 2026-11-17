// 送ったバッチ処理を諦める所。期限を過ぎた物と続けて見つからない物を失敗にして知らせ、入れなかった答えを残す (サービスと拡張の 3.6)
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import { noticeOnce } from "../work/notice.ts";
import type { BatchResult } from "./claude-batch.ts";

/** 送ったバッチを諦めるまでの間。Anthropic のバッチは 24 時間で切れるので、1 時間の余りを見る (https://docs.claude.com/en/build-with-claude/batch-processing) */
export const BATCH_DEADLINE_MS = 25 * 60 * 60_000;

/** 続けて見つからなかったら諦める回数 */
export const BATCH_NOT_FOUND_LIMIT = 3;

/** 終わったバッチの結果を入れるのが続けて落ちたら諦める回数。5 分ごとに見るので 1 時間 */
export const BATCH_APPLY_LIMIT = 12;

/** 送ってから結果を読める間。Anthropic のバッチの結果は作ってから 29 日読める (https://docs.claude.com/en/build-with-claude/batch-processing) */
export const BATCH_RESULTS_MS = 29 * 24 * 60 * 60_000;

/** 諦めたバッチの通知の種類 */
export const BATCH_FAILED_NOTICE = "batch_failed";

/** 諦めるかを決める batches の行 */
export type SubmittedBatch = {
  /** 行の ID */
  id: string;
  /** 読んだ時の、続けて見つからなかった回数 */
  failures: number;
  /** 読んだ時の、結果を入れるのが続けて落ちた回数 */
  apply_failures: number;
  /** 送った時刻 */
  created_at: number;
  /** 種類 */
  kind: string;
  /** 週の始めの日。急ぐ故障は日と指紋 */
  week: string;
};

/**
 * 見つからなかった回数を足し、続けて上限に届いたら諦める
 * @param env バインディング
 * @param p batches の行
 * @param now 今の時刻
 */
export async function countNotFound(env: Bindings, p: SubmittedBatch, now: number): Promise<void> {
  // 同時に走った 2 つの見回りが同じ 404 を 2 度数えないよう、読んだ回数の時だけ足す
  const row = await env.DB.prepare("UPDATE batches SET failures = failures + 1 WHERE id = ? AND status = 'submitted' AND failures = ? RETURNING failures")
    .bind(p.id, p.failures)
    .first<{ failures: number }>();
  if (row && row.failures >= BATCH_NOT_FOUND_LIMIT) await failBatch(env, p, now, `続けて ${String(BATCH_NOT_FOUND_LIMIT)} 回見つからない`);
}

/**
 * 結果を入れるのが落ちた回数を足し、続けて上限に届くか結果を読める期限を過ぎたら諦める
 * @param env バインディング
 * @param p batches の行
 * @param now 今の時刻
 */
export async function countApplyFailure(env: Bindings, p: SubmittedBatch, now: number): Promise<void> {
  if (now > p.created_at + BATCH_RESULTS_MS) {
    await failBatch(env, p, now, "結果を読める期限を過ぎても結果を入れられない");
    return;
  }
  // 同時に走った 2 つの見回りが同じ落ちを 2 度数えないよう、読んだ回数の時だけ足す
  const row = await env.DB.prepare("UPDATE batches SET apply_failures = apply_failures + 1 WHERE id = ? AND status = 'submitted' AND apply_failures = ? RETURNING apply_failures")
    .bind(p.id, p.apply_failures)
    .first<{ apply_failures: number }>();
  if (row && row.apply_failures >= BATCH_APPLY_LIMIT) await failBatch(env, p, now, `結果を入れるのが続けて ${String(BATCH_APPLY_LIMIT)} 回落ちた`);
}

/**
 * 送ったバッチを諦め、オーナーに 1 件だけ知らせる。同時に 2 つが諦めても知らせるのは 1 度
 * @param env バインディング
 * @param p batches の行
 * @param now 今の時刻
 * @param reason 諦めた理由
 */
export async function failBatch(env: Bindings, p: SubmittedBatch, now: number, reason: string): Promise<void> {
  const res = await env.DB.prepare("UPDATE batches SET status = 'failed', ended_at = ? WHERE id = ? AND status = 'submitted'").bind(now, p.id).run();
  if (res.meta.changes !== 1) return;
  await noticeGiveUp(env, p, now, `送ったが、${reason}`);
}

/**
 * 諦めたバッチをエラーログに残し、種類ごとに 1 件だけ知らせる
 * @param env バインディング
 * @param p batches の行
 * @param p.kind 種類
 * @param p.week 週の始めの日。急ぐ故障は日と指紋
 * @param now 今の時刻
 * @param reason 諦めた理由
 */
export async function noticeGiveUp(env: Bindings, p: { kind: string; week: string }, now: number, reason: string): Promise<void> {
  await recordError(env, { source: "job", level: "error", code: `${p.kind}_batch_failed`, error: new Error(reason) }, clockAt(now));
  await noticeOnce(env, { kind: BATCH_FAILED_NOTICE, title: `バッチ処理を諦めた (${p.kind})`, body: `${p.week} の分は、${reason}。この分は送り直さないので、要れば記録を見て手で確かめる` }, now);
}

/**
 * 入れなかった答えを、理由ごとにエラーログに残す。上限で切れた答えが続くなら、上限か考える深さを見直す
 * @param env バインディング
 * @param kind 種類
 * @param answers バッチの結果
 * @param now 今の時刻
 */
export async function recordAnswerFailures(env: Bindings, kind: string, answers: BatchResult[], now: number): Promise<void> {
  for (const a of answers) {
    if (a.failure === undefined) continue;
    await recordError(env, { source: "job", level: "warn", code: `${kind}_answer_${a.failure}`, error: new Error(`${a.customId} の答えを入れなかった`) }, clockAt(now));
  }
}
