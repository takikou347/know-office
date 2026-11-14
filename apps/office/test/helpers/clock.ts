// テストで時刻を決めて渡す Clock
import type { Clock } from "@know-office/core";

/**
 * 決まった時刻を返し、進められる Clock を作る
 * @param start 始めの時刻 (協定世界時のミリ秒)
 * @returns now と advance を持つ Clock
 */
export function fixedClock(start: number): Clock & { advance(ms: number): void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}
