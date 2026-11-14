// ID は UUID v7 (RFC 9562 の 5.7)。頭 48 ビットが作った時刻なので、並べると作った順になる
import type { Clock } from "./clock.ts";

/**
 * UUID v7 を作る
 * @param clock 時刻
 * @returns 小文字の UUID v7
 */
export function newId(clock: Clock): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const at = clock.now();
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(at / 2 ** (8 * (5 - i))) & 0xff;
  // RFC 9562 の 4.1 と 4.2: 版 7 と変種 10
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
