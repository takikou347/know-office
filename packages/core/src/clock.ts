// 今の時刻の受け渡し。テストで時刻を進めるため、Date.now() を直に呼ばずにこれを引数で受ける
/** 今の時刻を返す物 */
export type Clock = {
  /** 今の時刻 (協定世界時のミリ秒) */
  now(): number;
};

/** 本物の時刻を返す Clock */
export const systemClock: Clock = { now: () => Date.now() };
