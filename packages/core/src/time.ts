// 日本時間への直し。時刻は協定世界時のミリ秒で持ち、日本時間に直すのはここだけ
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 日本時間の日を返す
 * @param at 協定世界時のミリ秒
 * @returns YYYY-MM-DD
 */
export function jstDay(at: number): string {
  return new Date(at + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 日本時間の時と分を返す
 * @param at 協定世界時のミリ秒
 * @returns HH:MM
 */
export function jstClock(at: number): string {
  return new Date(at + JST_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * 日本時間の年を返す。記録の置き場 REC_<年> を選ぶのに使う
 * @param at 協定世界時のミリ秒
 * @returns 年
 */
export function jstYear(at: number): number {
  return new Date(at + JST_OFFSET_MS).getUTCFullYear();
}

/**
 * 日本時間の日の 0 時を返す。期間で記録を絞るのに使う
 * @param day YYYY-MM-DD
 * @returns その日の日本時間の 0 時の、協定世界時のミリ秒
 */
export function jstDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - JST_OFFSET_MS;
}
