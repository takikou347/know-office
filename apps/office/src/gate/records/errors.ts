// エラーログを error_events に残す。書く入口はここの recordError だけ (ログインと記録の 3.8)
import { type Clock, jstYear, log, newId, redactText, sha256Hex } from "@know-office/core";
import { RECORD_BINDINGS, type Bindings } from "../env.ts";

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

const BURST_LIMIT = 3;
const BURST_WINDOW_MS = 5 * 60 * 1000;

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
  const top = record.error instanceof Error ? (record.error.stack?.split("\n")[1]?.trim() ?? "") : "";
  return sha256Hex([record.source, record.code, record.route ?? "", name, top].join("|"));
}

/**
 * エラーを error_events に 1 行足す。同じ原因が 5 分に 3 回を超えたら知らせを出す。書けない時は log にだけ残し、投げない
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
    const recent = await db
      .prepare("SELECT count(*) AS n FROM error_events WHERE fingerprint = ? AND at > ?")
      .bind(fingerprint, at - BURST_WINDOW_MS)
      .first<{ n: number }>();
    // 超えた 1 回目だけ知らせ、続く間は重ねない
    if (recent?.n === BURST_LIMIT + 1) {
      await env.DB.prepare("INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES (?, ?, 'warn', 'error_burst', ?, ?, 'office')")
        .bind(newId(clock), at, "同じエラーが続いている", `${record.route ?? record.source} で 5 分に ${String(BURST_LIMIT)} 回を超えた`)
        .run();
    }
  } catch (cause) {
    log("error", "record_error_failed", { traceId: record.traceId, message: messageOf(cause) });
  }
}
