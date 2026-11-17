// GitHub の API のレート制限に届いた事を、エラーログと通知に残す (サービスと拡張の 3.5)
import { type Clock, log } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { GITHUB_RATE_LIMITED, recordError } from "../ledger/errors.ts";
import { noticeOnce } from "../work/notice.ts";

/** レート制限の通知の題。読むまで重ねない */
const RATE_TITLE = "GitHub の API のレート制限に届いた";

/**
 * GitHub のレート制限をエラーログに残し、通知 github_rate_limited を出す。通知を書けなくても投げず、log に残す
 * @param env バインディング
 * @param clock 時刻
 * @param hit 待つ秒と、道、返したステータス、traceId
 * @param hit.seconds 送り直してよいまでの秒
 * @param hit.route 道
 * @param hit.status 返したステータス
 * @param hit.traceId トレース ID
 */
export async function noteGitHubRateLimit(env: Bindings, clock: Clock, hit: { seconds: number; route: string; status: number; traceId: string }): Promise<void> {
  const { seconds, ...origin } = hit;
  await recordError(env, { source: "gate", level: "warn", code: GITHUB_RATE_LIMITED, error: new Error("GitHub の API のレート制限"), ...origin }, clock);
  await noticeGitHubRateLimit(env, clock, seconds, origin.traceId);
}

/**
 * 通知 github_rate_limited だけを出す。エラーログは呼ぶ側が自分の code で残す時に使う。通知を書けなくても投げず、log に残す
 * @param env バインディング
 * @param clock 時刻
 * @param seconds 送り直してよいまでの秒
 * @param traceId トレース ID。要求の外なら無し
 */
export async function noticeGitHubRateLimit(env: Bindings, clock: Clock, seconds: number, traceId?: string): Promise<void> {
  const body = `GitHub の API がレート制限で断った。${String(seconds)} 秒後から送り直せる。社員の GitHub の操作はそれまで断られる`;
  await noticeOnce(env, { kind: GITHUB_RATE_LIMITED, title: RATE_TITLE, body }, clock.now()).catch((cause: unknown) => {
    log("error", "github_rate_notice_failed", { traceId, error: cause instanceof Error ? cause.message : "unknown" });
  });
}
