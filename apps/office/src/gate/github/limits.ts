// GitHub の API のレート制限に届いた事を、エラーログと通知に残す (サービスと拡張の 3.5)
import { AppError, type Clock, log } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { GITHUB_RATE_LIMITED, recordError } from "../ledger/errors.ts";
import { noticeOnce } from "../work/run.ts";

/** レート制限の通知の題。読むまで重ねない */
const RATE_TITLE = "GitHub の API のレート制限に届いた";

/** ゲートウェイが GitHub を呼んでレート制限に当たった時に投げる 429。onError が見分けて通知を出す */
export class GitHubRateLimited extends AppError {
  /**
   * @param seconds 送り直してよいまでの秒
   */
  constructor(readonly seconds: number) {
    super("rate_limited", "GitHub の上限に届いた", { headers: { "Retry-After": String(seconds) } });
  }
}

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
  const body = `GitHub の API がレート制限で断った。${String(seconds)} 秒後から送り直せる。社員の GitHub の操作はそれまで断られる`;
  await noticeOnce(env, { kind: GITHUB_RATE_LIMITED, title: RATE_TITLE, body }, clock.now()).catch((cause: unknown) => {
    log("error", "github_rate_notice_failed", { traceId: origin.traceId, error: cause instanceof Error ? cause.message : "unknown" });
  });
}
