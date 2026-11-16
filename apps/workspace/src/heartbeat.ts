// ワークスペースが 30 秒ごとにゲートウェイへハートビートを送る。90 秒届かなければ社員 DO がワークスペースを作り直す (社員と勤怠の 3.5)
import { allowedFetch, type Clock, type Fetcher, log } from "@know-office/core";
import { GATE_ORIGIN } from "./hooks.ts";

/** ハートビートのルート。作業トークンは要らず、受け手が送ったワークスペースから社員を決める */
export const GATE_HEARTBEAT_URL = `${GATE_ORIGIN}ws/v1/heartbeat`;

/** 送る間 (30 秒)。社員 DO は 90 秒届かなければ落ちたとみる */
export const HEARTBEAT_EVERY_MS = 30_000;

/** 外を呼ぶ時の待ち (10 秒) */
const TIMEOUT_MS = 10_000;

/** ハートビートの依り所 */
export type HeartbeatDeps = {
  /** ゲートウェイを呼ぶ関数 */
  fetcher: Fetcher;
  /** 今の時刻 */
  clock: Clock;
  /** 間をおいて繰り返す。止める関数を返す。省くと setInterval */
  every?: (fn: () => void, ms: number) => () => void;
};

/**
 * ハートビートを起きてすぐと 30 秒ごとに送り始める。送れなくても止めず、前の送りが返るまで重ねない
 * @param deps ゲートウェイを呼ぶ関数、時刻、繰り返し方
 * @returns 止める関数
 */
export function startHeartbeat(deps: HeartbeatDeps): () => void {
  let sending = false;
  const beat = (): void => {
    if (sending) return;
    sending = true;
    allowedFetch(deps.fetcher, GATE_HEARTBEAT_URL, [GATE_ORIGIN], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: new Date(deps.clock.now()).toISOString() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(async (res) => {
        await res.body?.cancel();
        if (!res.ok) log("warn", "heartbeat_failed", { status: res.status });
      })
      .catch(() => log("warn", "heartbeat_failed", { status: 0 }))
      .finally(() => {
        sending = false;
      });
  };
  const every =
    deps.every ??
    ((fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
  const stop = every(beat, HEARTBEAT_EVERY_MS);
  beat();
  return stop;
}
