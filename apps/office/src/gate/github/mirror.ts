// know-office の中のレビューを GitHub のプルリクエストに写す。書く時に順番待ちに入れ、すぐに送り、送れなければエラーログに残して 5 分ごとに送り直す (タスクとレビューの 3.6)
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { type Clock, MirrorCommentPayload, MirrorReviewPayload, newId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import type { Forge } from "../work/loop.ts";

/** 送る者の印の長さ (1 分)。GitHub の呼び出しの待ち時間 (10 秒) の数回分より長くし、落ちた者の印は次の回に外れる */
const CLAIM_MS = 60_000;
/** 送る回数の上限。5 分ごとに送り直すので、およそ 1 時間であきらめる */
export const MIRROR_ATTEMPTS = 12;
/** 1 回の送り直しで送る数の上限 */
const RETRY_BATCH = 20;

/** 写す物 1 つ。review は可か不可のレビュー、comment は行のコメント */
export type Mirror = { kind: "review"; payload: MirrorReviewPayload } | { kind: "comment"; payload: MirrorCommentPayload };

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
type Claimed = { kind: string; payload: string; attempts: number; repo: string | null; pr_number: number | null };

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
  const row = await env.DB.prepare(
    `UPDATE github_mirrors SET claimed_until = ?, attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL AND attempts < ? AND (claimed_until IS NULL OR claimed_until <= ?)
     RETURNING review_id, kind, payload, attempts`,
  )
    .bind(now + CLAIM_MS, id, MIRROR_ATTEMPTS, now)
    .first<{ review_id: string; kind: string; payload: string; attempts: number }>();
  if (!row) return "skipped";
  const target = await env.DB.prepare("SELECT repo, pr_number FROM reviews WHERE id = ?").bind(row.review_id).first<{ repo: string; pr_number: number }>();
  const claimed: Claimed = { ...row, repo: target?.repo ?? null, pr_number: target?.pr_number ?? null };
  let githubId: number;
  try {
    githubId = await post(forge, claimed);
  } catch (error) {
    await env.DB.prepare("UPDATE github_mirrors SET claimed_until = NULL WHERE id = ? AND sent_at IS NULL").bind(id).run();
    const gaveUp = claimed.attempts >= MIRROR_ATTEMPTS;
    await recordError(env, { source: "job", level: gaveUp ? "error" : "warn", code: gaveUp ? "github_mirror_gave_up" : "github_mirror_failed", error }, clock);
    return "failed";
  }
  await env.DB.prepare("UPDATE github_mirrors SET github_id = ?, sent_at = ?, claimed_until = NULL WHERE id = ? AND sent_at IS NULL").bind(githubId, clock.now(), id).run();
  return "sent";
}

/**
 * 取った行の中身を形で確かめ、GitHub に送る
 * @param forge GitHub
 * @param claimed 取った行
 * @returns GitHub のレビューかコメントの ID
 * @throws Error 中身の形が違う時、レビューが無い時
 * @throws upstream_failed GitHub が失敗を返した時
 */
async function post(forge: Forge, claimed: Claimed): Promise<number> {
  if (claimed.repo === null || claimed.pr_number === null) throw new Error("写す先のレビューが無い");
  const raw: unknown = JSON.parse(claimed.payload);
  if (claimed.kind === "review") return forge.postReview(claimed.repo, claimed.pr_number, MirrorReviewPayload.parse(raw));
  return forge.postComment(claimed.repo, claimed.pr_number, MirrorCommentPayload.parse(raw));
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
