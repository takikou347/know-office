// 画面に出す文の形。時刻は日本時間で出す
import type { AttendanceReason, DaySummary, WorkEntry, WorkResult } from "@know-office/core";

const jst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit", hourCycle: "h23" });

const MINUTE = 60_000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 勤怠の理由を画面の言葉にする */
const REASON_LABELS: Record<AttendanceReason, string> = {
  schedule: "所定の時刻",
  checkpoint_wait: "チェックポイントを待った",
  owner_instruction: "オーナーの指示",
  guard_stop: "自動停止",
  rate_limit: "API の上限",
  workspace_down: "ワークスペースが落ちた",
};

/** タスクを離れた時の結果を画面の言葉にする */
const RESULT_LABELS: Record<WorkResult, string> = {
  done: "済んだ",
  handed_back: "上司に戻した",
  stopped: "止められた",
  continued: "次の日へ続く",
};

/**
 * 協定世界時の時刻を、日本時間の「9:05」の形にする
 * @param iso RFC 3339 の時刻
 * @returns 日本時間の時と分
 */
export function jstTime(iso: string): string {
  return jst.format(new Date(iso));
}

/**
 * 分を「7 時間 55 分」の形にする
 * @param minutes 分の数
 * @returns 時間と分の文
 */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分`;
  return m === 0 ? `${h} 時間` : `${h} 時間 ${m} 分`;
}

/**
 * ミリ秒を切り捨てた分にする
 * @param ms ミリ秒
 * @returns 分
 */
const minutes = (ms: number) => Math.floor(ms / MINUTE);

/**
 * 日本時間の日を「11/14 (金)」の形にする
 * @param day YYYY-MM-DD
 * @returns 月、日、曜日
 */
function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()} (${WEEKDAYS[date.getUTCDay()] ?? ""})`;
}

/**
 * 集計の理由から、その区分の理由を画面の言葉で並べる
 * @param reasons `<出来事>:<理由>` の並び
 * @param kind 区分
 * @returns 括弧の付いた理由。無ければ空
 */
function why(reasons: string[], kind: "extension" | "stopped"): string {
  const labels = reasons.flatMap((r) => {
    const [event, reason] = r.split(":");
    const label = Object.entries(REASON_LABELS).find(([key]) => key === reason)?.[1];
    return event === kind && label ? [label] : [];
  });
  return labels.length > 0 ? ` (${labels.join("、")})` : "";
}

/**
 * 勤怠の表の上の 1 行を作る。出勤していない日は「なし」、退勤していない日は「まだ」
 * @param d 1 日の勤怠のまとめ
 * @returns 出勤、退勤、働いた時間、延長、止められていた時間を並べた文
 */
export function daySummaryText(d: DaySummary): string {
  const clockIn = d.clockIn ? jstTime(d.clockIn) : "なし";
  let clockOut = d.clockIn ? "まだ" : "なし";
  if (d.clockOut) clockOut = jstTime(d.clockOut);
  return [
    `${dayLabel(d.day)} 出勤 ${clockIn}`,
    `退勤 ${clockOut}`,
    `働いた ${duration(minutes(d.workedMs))}`,
    `延長 ${minutes(d.extensionMs)} 分${why(d.reasons, "extension")}`,
    `止められていた ${minutes(d.stoppedMs)} 分${why(d.reasons, "stopped")}`,
  ].join("、");
}

/**
 * タスク 1 件を勤怠の表の 1 行にする
 * @param e その日に手を付けたタスク
 * @returns 始めた時刻、終えた時刻、名前、掛かった分、サービス、結果
 */
export function workEntryRow(e: WorkEntry) {
  return {
    key: e.id,
    start: jstTime(e.startedAt),
    end: jstTime(e.endedAt),
    task: e.title,
    minutes: minutes(e.activeMs),
    service: e.scope,
    result: RESULT_LABELS[e.result],
  };
}
