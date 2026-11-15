// 部屋を描く回し方。requestAnimationFrame を 30fps に間引き、止めている間は次を頼まず、再開した時は止めていた分だけ時刻をずらす

/** 描く回し方に使う時計 (テストでは作り物を渡す) */
export interface LoopClock {
  /** 今の時刻 (ミリ秒) */
  now: () => number;
  /** 次の描画を頼む */
  request: (cb: (t: number) => void) => number;
  /** 頼んだ描画を取り消す */
  cancel: (id: number) => void;
}

/** 描く回し方 */
export interface Loop {
  /** 描き始める。止めていた後なら、止めていた分だけ時刻をずらして続ける */
  start: () => void;
  /** 描くのを止める。次の描画を頼まない */
  pause: () => void;
  /** 片付ける。この後は始めても描かない */
  stop: () => void;
}

/**
 * ブラウザの時計を返す
 * @returns performance と requestAnimationFrame を使う時計
 */
export function browserClock(): LoopClock {
  return {
    now: () => performance.now(),
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  };
}

/**
 * 描く回し方を作る
 * @param frame 描く関数。止めていた時間を除いた時刻 (ミリ秒) を受ける
 * @param clock 時計
 * @param fps 1 秒に描く回数の上限
 * @returns 描く回し方
 */
export function createLoop(frame: (t: number) => void, clock: LoopClock, fps = 30): Loop {
  // 画面の更新の揺れで 1 回分を飛ばさないよう、間隔を 1 ミリ秒だけ短く見る
  const interval = 1000 / fps - 1;
  let id: number | null = null;
  let last = -Infinity;
  let offset = 0;
  let pausedAt: number | null = null;
  let stopped = false;
  const tick = (t: number) => {
    id = clock.request(tick);
    if (t - last < interval) return;
    last = t;
    frame(t - offset);
  };
  const halt = () => {
    if (id !== null) clock.cancel(id);
    id = null;
  };
  return {
    start: () => {
      const idle = id === null;
      if (stopped || !idle) return;
      if (pausedAt !== null) offset += clock.now() - pausedAt;
      pausedAt = null;
      id = clock.request(tick);
    },
    pause: () => {
      const running = id !== null;
      if (running) pausedAt = clock.now();
      halt();
    },
    stop: () => {
      stopped = true;
      halt();
    },
  };
}
