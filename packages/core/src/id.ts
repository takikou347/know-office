// ID は UUID v7 (RFC 9562 の 5.7)。頭 48 ビットが作った時刻なので、並べると作った順になる
import type { Clock } from "./clock.ts";

/**
 * 時刻と 16 バイトから UUID v7 の文字列を組む
 * @param at 頭に入れる時刻 (協定世界時のミリ秒)
 * @param bytes 時刻の後ろを埋める 16 バイト。頭の 6 バイトは時刻で上書きする
 * @returns 小文字の UUID v7
 */
function uuidV7(at: number, bytes: Uint8Array): string {
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) & 0xff;
  // RFC 9562 の 4.1 と 4.2: 版 7 と変種 10
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * UUID v7 を作る
 * @param clock 時刻
 * @returns 小文字の UUID v7
 */
export function newId(clock: Clock): string {
  return uuidV7(clock.now(), crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * 時刻と鍵から決まる UUID v7 を作る。1 つの物に 1 行だけ持たせたい時の ID にし、`ON CONFLICT DO NOTHING` で重ねずに書く
 * @param at 頭に入れる時刻 (協定世界時のミリ秒)
 * @param key 物を決める鍵 (例 `attendance_overlap:builder:2026-11-14`)
 * @returns 小文字の UUID v7
 */
export async function keyedId(at: number, key: string): Promise<string> {
  // 時刻の後ろの 74 ビットを、乱数の代わりに鍵の SHA-256 で埋める (RFC 9562 の 6.9 の作り方の 1 つ)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return uuidV7(at, new Uint8Array(digest).slice(0, 16));
}
