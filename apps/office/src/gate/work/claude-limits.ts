// Claude の API の使用の上限とレートの上限を、エラーログと通知に残す (サービスと拡張の 3.5)
import { type ClaudeSpendLimit, type Clock, log, redactText, type SpendLimitKind } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { CLAUDE_RATE_LIMITED, CLAUDE_SPEND_LIMIT, recordError } from "../ledger/errors.ts";
import { recordsOf } from "./nodes.ts";
import { noticeOnce, SPEND_LIMIT_NOTICE } from "./run.ts";

/** レートの上限を数える窓と、通知を出す回数 */
export const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
export const RATE_LIMIT_NOTICE_COUNT = 5;

/** 使用の上限の通知の題。どの種類でも 1 つにし、読むまで重ねない */
const SPEND_TITLE = "Claude の API の使用の上限に届いた";

/** レートの上限の通知の題 */
const RATE_TITLE = "Claude の API のレート制限が続いている";

/** 通知の本文に書く Claude の API の文の長さ */
const MESSAGE_HEAD = 200;

/** 使用の上限の種類の名前 */
const SPEND_LABEL: Record<SpendLimitKind, string> = {
  organization: "組織の上限 (Console で決めた上限)",
  workspace: "workspace の上限 (Console で決めた上限)",
  monthly: "月の使用の上限",
  billing: "支払い",
};

/** 残りが 0 なら届いた制限とみなすヘッダー。出典: platform.claude.com/docs/en/api/rate-limits の Response headers */
const REMAINING_HEADERS = [
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-output-tokens-remaining",
] as const;

/** 呼んだ要求の印 */
type Origin = { route: string; status: number; traceId: string };

/**
 * 使用の上限をエラーログに残し、通知 claude_spend_limit を出す。通知を書けなくても投げず、log に残す
 * @param env バインディング
 * @param clock 時刻
 * @param limit 見分けた使用の上限
 * @param origin 道、ステータス、traceId
 */
export async function noteSpendLimit(env: Bindings, clock: Clock, limit: ClaudeSpendLimit, origin: Origin): Promise<void> {
  await recordError(env, { source: "gate", level: "warn", code: CLAUDE_SPEND_LIMIT, error: new Error(`Claude API の使用の上限 (${limit.kind})`), ...origin }, clock);
  const head = redactText(limit.message).slice(0, MESSAGE_HEAD);
  const body = `${SPEND_LABEL[limit.kind]}に届いた。Console の上限か支払いを直してから、この通知を読むと社員が続きを始める。Claude の API の文: ${head}`;
  await noticeOnce(env, { kind: SPEND_LIMIT_NOTICE, title: SPEND_TITLE, body }, clock.now(), "stop").catch((cause: unknown) => {
    log("error", "claude_spend_notice_failed", { traceId: origin.traceId, error: cause instanceof Error ? cause.message : "unknown" });
  });
}

/**
 * レートの上限の 429 をエラーログに残し、直前の 5 分に 5 回に届いていれば通知 claude_rate_limited を出す。通知を書けなくても投げず、log に残す
 * @param env バインディング
 * @param clock 時刻
 * @param headers Claude の API の返事のヘッダー
 * @param origin 道、ステータス、traceId
 */
export async function noteRateLimit(env: Bindings, clock: Clock, headers: Headers, origin: Origin): Promise<void> {
  await recordError(env, { source: "gate", level: "warn", code: CLAUDE_RATE_LIMITED, error: new Error("Claude API のレートの上限"), ...origin }, clock);
  try {
    const at = clock.now();
    // 窓の端 (ちょうど 5 分前) の行は数えない
    const recent = await recordsOf(env, at)
      .prepare("SELECT count(*) AS n FROM error_events WHERE code = ? AND at > ?")
      .bind(CLAUDE_RATE_LIMITED, at - RATE_LIMIT_WINDOW_MS)
      .first<{ n: number }>();
    const count = recent?.n ?? 0;
    if (count < RATE_LIMIT_NOTICE_COUNT) return;
    const reached = REMAINING_HEADERS.filter((name) => headers.get(name) === "0");
    const body = `5 分に ${String(count)} 回、レート制限で断られた。届いた制限: ${reached.length > 0 ? reached.join("、") : "不明"}`;
    await noticeOnce(env, { kind: CLAUDE_RATE_LIMITED, title: RATE_TITLE, body }, at);
  } catch (cause) {
    log("error", "claude_rate_notice_failed", { traceId: origin.traceId, error: cause instanceof Error ? cause.message : "unknown" });
  }
}
