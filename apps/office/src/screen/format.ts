// 画面に出す文の形。時刻は日本時間で出す
import type { DaySummary } from "./mock.ts";

const jst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit", hourCycle: "h23" });

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

const why = (reason?: string) => (reason ? ` (${reason})` : "");

/**
 * 勤怠の表の上の 1 行を作る
 * @param d 1 日の勤怠のまとめ
 * @returns 出勤、退勤、働いた時間、延長、止められていた時間を並べた文
 */
export function daySummaryText(d: DaySummary): string {
  return [
    `${d.date} 出勤 ${d.in}`,
    `退勤 ${d.out}`,
    `働いた ${duration(d.workedMinutes)}`,
    `延長 ${d.overtimeMinutes} 分${why(d.overtimeReason)}`,
    `止められていた ${d.stoppedMinutes} 分${why(d.stoppedReason)}`,
  ].join("、");
}
