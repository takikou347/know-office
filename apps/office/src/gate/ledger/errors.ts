// エラーログを error_events に残す。書く入口はここの recordError だけ (ログインと記録の 3.6)
import { type Clock, jstYear, log, newId, redactText, sha256Hex } from "@know-office/core";
import { RECORD_BINDINGS, type Bindings } from "../env.ts";
import { liveOf } from "../live/publish.ts";

/** 残すエラー */
export type ErrorRecord = {
  /** 起きた所 */
  source: "gate" | "staff_do" | "recorder_do" | "guard_do" | "live_do" | "workspace" | "job";
  /** error か warn */
  level: "error" | "warn";
  /** 失敗の種類 */
  code: string;
  /** 投げられた物 */
  error: unknown;
  /** ルート。ルートの外なら無し */
  route?: string;
  /** 返したステータス */
  status?: number;
  /** トレース ID */
  traceId?: string;
};

/** Claude の API の失敗をエラーログに残す時の code。続いた時は notices.ts が claude_failing を出す */
export const CLAUDE_FAILED = "claude_failed";

/** Claude の API が使用の上限に届いた時の code。work/claude-limits.ts がすぐ claude_spend_limit を出す */
export const CLAUDE_SPEND_LIMIT = "claude_spend_limit";

/** Claude の API のレートの上限の 429 の code。続いた時は work/claude-limits.ts が claude_rate_limited を出す */
export const CLAUDE_RATE_LIMITED = "claude_rate_limited";

/** GitHub の API のレート制限の code。github/limits.ts がすぐ github_rate_limited を出す */
export const GITHUB_RATE_LIMITED = "github_rate_limited";

/** Cloudflare の Analytics を読めなかった時の code。続いた時は services/analytics.ts が analytics_failing を出す */
export const ANALYTICS_FAILED_CODE = "cloudflare_analytics_failed";

/** Cloudflare の Analytics で読まなかったサービスの code (スクリプト名の形が違う、1 回に読む上限を超えた)。通知は出さない */
export const ANALYTICS_SKIPPED_CODE = "cloudflare_analytics_skipped";

/** 5xx の数と Worker のエラーの和が呼び出しの数を超え、呼び出しの数までにした時の code。2 つの API は別々に集まるので起こりうる。通知は出さない */
export const ANALYTICS_CAPPED_CODE = "cloudflare_analytics_capped";

/** 自分の通知を持つので (cloudflare_analytics_failed は services/analytics.ts、cloudflare_analytics_skipped と cloudflare_analytics_capped は通知を出さない、sdk_auth_failed、claude_spend_limit、claude_rate_limited、github_rate_limited は work/notice.ts の noticeOnce)、同じエラーの続き (error_burst) の通知を出さない code */
const OWN_NOTICE_CODES: ReadonlySet<string> = new Set([CLAUDE_FAILED, CLAUDE_SPEND_LIMIT, CLAUDE_RATE_LIMITED, GITHUB_RATE_LIMITED, ANALYTICS_FAILED_CODE, ANALYTICS_SKIPPED_CODE, ANALYTICS_CAPPED_CODE, "sdk_auth_failed"]);

/** 同じ原因のエラーが続いたとみなす、5 分の回数。これを超えたら知らせ、急ぐ故障として調べる */
export const BURST_LIMIT = 3;
/** 同じ原因のエラーを数える間 */
export const BURST_WINDOW_MS = 5 * 60 * 1000;

/**
 * 残す文を作る。エラーの名前と、鍵を伏せた 200 字までの文
 * @param error 投げられた物
 * @returns 残す文
 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "非 Error の値";
  return redactText(text).slice(0, 200);
}

/**
 * 同じ原因をまとめる鍵を作る。起きた所、種類、ルート、エラーの名前、最初のスタックの行から作る
 * @param record 残すエラー
 * @returns SHA-256
 */
function fingerprintOf(record: ErrorRecord): Promise<string> {
  const name = record.error instanceof Error ? record.error.name : "unknown";
  // 文は鍵や ID で毎回変わるので使わず、投げた場所 (スタックの 1 行目の呼び出し元) で同じ原因をまとめる
  const top = record.error instanceof Error ? (record.error.stack?.split("\n")[1]?.trim() ?? "") : "";
  return sha256Hex([record.source, record.code, record.route ?? "", name, top].join("|"));
}

/**
 * エラーを error_events に 1 行足す。同じ原因が 5 分に 3 回を超えたら知らせを出す。自分の通知を持つ code は除く。書けない時は log にだけ残し、投げない
 * @param env バインディング
 * @param record 残すエラー
 * @param clock 時刻
 */
export async function recordError(env: Bindings, record: ErrorRecord, clock: Clock): Promise<void> {
  const at = clock.now();
  try {
    const name = RECORD_BINDINGS.find((b) => b === `REC_${String(jstYear(at))}`);
    const db = name ? env[name] : undefined;
    if (!db) throw new Error(`REC_${String(jstYear(at))} が無い`);
    const fingerprint = await fingerprintOf(record);
    await db
      .prepare("INSERT INTO error_events (id, at, source, level, code, message, route, status, fingerprint, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(clock), at, record.source, record.level, record.code, messageOf(record.error), record.route ?? null, record.status ?? null, fingerprint, record.traceId ?? null)
      .run();
    if (OWN_NOTICE_CODES.has(record.code)) return;
    const recent = await db
      .prepare("SELECT count(*) AS n FROM error_events WHERE fingerprint = ? AND at > ?")
      .bind(fingerprint, at - BURST_WINDOW_MS)
      .first<{ n: number }>();
    // 超えた 1 回目だけ知らせ、続く間は重ねない
    if (recent?.n === BURST_LIMIT + 1) {
      const id = newId(clock);
      await env.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES (?, ?, 'warn', 'error_burst', ?, ?, 'office')")
        .bind(id, at, "同じエラーが続いている", `${record.route ?? record.source} で 5 分に ${String(BURST_LIMIT)} 回を超えた`)
        .run();
      // 配れなかった時にまたエラーログを書くと、続きの通知が回り続けるので、log にだけ残す
      await liveOf(env)
        .publish({ type: "notice", notice: { id } })
        .catch((cause: unknown) => log("warn", "live_publish_failed", { message: messageOf(cause) }));
    }
  } catch (cause) {
    log("error", "record_error_failed", { traceId: record.traceId, message: messageOf(cause) });
  }
}
