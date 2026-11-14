// ゲートウェイの Hono の型。バインディングと、要求ごとの値を Variables に置く
import type { D1Database, DurableObjectNamespace, Rpc } from "@cloudflare/workers-types";
import type { Clock } from "@know-office/core";
import type { ChainCheck } from "./ledger/audit.ts";

/** 記録 DO の RPC。画面の型から DO のコードを読まないよう、ここに形だけを置く */
export interface Recorder extends Rpc.DurableObjectBranded {
  /** 監査ログに 1 行足す */
  append(input: unknown): Promise<{ id: string; hash: string }>;
  /** その年のハッシュチェーンを確かめる */
  verify(year: number): Promise<ChainCheck>;
}

/** 記録を年ごとに置く D1 のバインディングの名前。04-detail.md の 3.5 */
export const RECORD_BINDINGS = ["REC_2026", "REC_2027", "REC_2028", "REC_2029", "REC_2030", "REC_2031"] as const;

/** 記録の D1 のバインディングの名前 */
export type RecordBinding = (typeof RECORD_BINDINGS)[number];

/** Worker のバインディングと変数。wrangler の設定と同じ名前にする (04-detail.md の 3.5) */
export type Bindings = {
  /** 今の状態の D1 */
  DB: D1Database;
  /** 記録 DO */
  RECORDER: DurableObjectNamespace<Recorder>;
} & Partial<Record<RecordBinding, D1Database>>;

/** ゲートウェイの Hono に渡す型。バインディングとミドルウェアが置く値の型を持つ */
export type GateEnv = {
  Bindings: Bindings;
  Variables: {
    /** 要求ごとのトレース ID。traceparent の trace-id と同じ 32 桁の 16 進数 */
    traceId: string;
    /** 今の時刻。テストは createApp に渡して決める */
    clock: Clock;
  };
};
