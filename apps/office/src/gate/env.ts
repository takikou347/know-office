// ゲートウェイの Hono の型。要求ごとの値を Variables に置く

export type GateEnv = {
  Variables: {
    /** 要求ごとのトレース ID。traceparent の trace-id と同じ 32 桁の 16 進数 */
    traceId: string;
  };
};
