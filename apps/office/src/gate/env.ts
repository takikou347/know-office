// ゲートウェイの Hono の型。要求ごとの値を Variables に置く

/** ゲートウェイの Hono に渡す型。ミドルウェアが置く値の型を持つ */
export type GateEnv = {
  Variables: {
    /** 要求ごとのトレース ID。traceparent の trace-id と同じ 32 桁の 16 進数 */
    traceId: string;
  };
};
