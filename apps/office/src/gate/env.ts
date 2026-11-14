// ゲートウェイの Hono の型。バインディングと、要求ごとの値を Variables に置く
import type { D1Database, DurableObjectNamespace, Rpc } from "@cloudflare/workers-types";
import type { Clock, Fetcher, StaffStatus } from "@know-office/core";
import type { Admission, Challenge, RateBucket } from "./auth/guard-book.ts";
import type { SessionRow } from "./auth/session.ts";
import type { ChainCheck } from "./ledger/audit.ts";

/** 記録 DO の RPC。画面の型から DO のコードを読まないよう、ここに形だけを置く */
export interface Recorder extends Rpc.DurableObjectBranded {
  /** 監査ログに 1 行足す */
  append(input: unknown): Promise<{ id: string; hash: string }>;
  /** その年のハッシュチェーンを確かめる */
  verify(year: number): Promise<ChainCheck>;
  /** バインドした D1 ごとの使った量 */
  size(): Promise<{ binding: string; bytes: number }[]>;
}

/** 全体のセキュリティ DO の RPC。時刻は呼ぶ側の Clock で渡す */
export interface Guard extends Rpc.DurableObjectBranded {
  /** 入口で通すかを決める */
  admit(ip: string, bucket: RateBucket, now: number): Promise<Admission>;
  /** ログインの証明かパスキーの失敗を 1 回数える */
  fail(ip: string, now: number): Promise<{ locked: boolean }>;
  /** challenge をログインセッションに結ぶ */
  putChallenge(sessionId: string, challenge: Challenge, now: number): Promise<null>;
  /** challenge を取り出して消す */
  takeChallenge(sessionId: string, now: number): Promise<Challenge | null>;
}

/** 社員 DO の RPC。時刻は呼ぶ側の Clock で渡す。入力は DO の中で Zod で確かめる (社員と勤怠の 1.3) */
export interface Staff extends Rpc.DurableObjectBranded {
  /** その時刻までに来た出来事を処理する */
  wake(now: number): Promise<null>;
  /** 今の状態を返す */
  status(now: number): Promise<StaffStatus>;
  /** ワークスペースのハートビートを受ける */
  heartbeat(at: number): Promise<null>;
  /** チェックポイントを受ける */
  checkpoint(input: unknown, now: number): Promise<null>;
  /** 新しいタスクを取るかを決める */
  take(task: unknown, medianMs: number | null, now: number): Promise<{ taken: boolean }>;
  /** 今のタスクを離れる */
  finish(result: unknown, now: number): Promise<null>;
  /** その日だけの指示を受ける */
  order(order: unknown, now: number): Promise<null>;
  /** 時間外に呼び出す */
  call(task: unknown, now: number): Promise<null>;
  /** API の上限で待ち始める */
  waitStart(reason: unknown, now: number): Promise<null>;
  /** API の上限の待ちを解く */
  waitEnd(now: number): Promise<null>;
  /** 自動停止で止める */
  stop(now: number): Promise<null>;
  /** 止めていたのを再開する */
  resume(now: number): Promise<null>;
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
  /** 全体のセキュリティ DO */
  GUARD: DurableObjectNamespace<Guard>;
  /** 社員 DO。社員 ID ごとに 1 つ */
  STAFF: DurableObjectNamespace<Staff>;
  /** production、preview、development */
  ENVIRONMENT?: string;
  /** 開発環境の代わりの物の置き場 */
  DEV_FAKES_URL?: string;
  /** Cloudflare Access のチーム名 */
  ACCESS_TEAM: string;
  /** Access のアプリの宛先 (aud) */
  ACCESS_AUD: string;
  /** オーナーのメールアドレス。Access の証明の email と比べる */
  OWNER_EMAIL: string;
  /** vault の鍵を暗号にする主の鍵。32 バイトを base64 で */
  MASTER_KEY: string;
} & Partial<Record<RecordBinding, D1Database>>;

/** ゲートウェイの Hono に渡す型。バインディングとミドルウェアが置く値の型を持つ */
export type GateEnv = {
  Bindings: Bindings;
  Variables: {
    /** 要求ごとのトレース ID。traceparent の trace-id と同じ 32 桁の 16 進数 */
    traceId: string;
    /** 今の時刻。テストは createApp に渡して決める */
    clock: Clock;
    /** 送信元の IP。CF-Connecting-IP */
    ip: string;
    /** Access の証明で確かめたメールアドレス */
    email: string;
    /** 今の要求のログインセッション。POST /api/v1/sessions では無い */
    session: SessionRow | undefined;
    /** 外への fetch。テストは代わりの物を渡す */
    fetch: Fetcher;
  };
};
