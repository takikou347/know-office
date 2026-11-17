// ゲートウェイの Hono の型。バインディングと、要求ごとの値を Variables に置く
import type { D1Database, DurableObjectNamespace, R2Bucket, Rpc } from "@cloudflare/workers-types";
import type { Clock, Fetcher, GuardKeys, KeyKind, RestoreInput, StaffStatus } from "@know-office/core";
import type { Admission, Challenge, RateBucket } from "./auth/guard-book.ts";
import type { SessionRow } from "./auth/session.ts";
import type { GuardDeps, Observed } from "./guard/deps.ts";
import type { KeyState } from "./guard/office-guard.ts";
import type { IssuedTicket, RenewedTicket, TicketCheck } from "./guard/staff-guard.ts";
import type { ChainCheck } from "./ledger/audit.ts";
import type { TokenDeps } from "./github/app.ts";
import type { Forge } from "./work/loop.ts";
import type { LspPrepared } from "./work/editor-lsp.ts";

/** 記録 DO の RPC。画面の型から DO のコードを読まないよう、ここに形だけを置く */
export interface Recorder extends Rpc.DurableObjectBranded {
  /** 監査ログに 1 行足す */
  append(input: unknown): Promise<{ id: string; hash: string }>;
  /** その年のハッシュチェーンを確かめる */
  verify(year: number): Promise<ChainCheck>;
  /** バインドした D1 ごとの使った量 */
  size(): Promise<{ binding: string; bytes: number }[]>;
  /** その時刻の年の監査ログから、操作と対象の合う行の detail を JSON の文字列で読む */
  find(at: number, action: string, target: string): Promise<{ detail: string | null } | null>;
}

/** 全体のセキュリティ DO の RPC。時刻は呼ぶ側の Clock で渡す */
export interface Guard extends Rpc.DurableObjectBranded {
  /** 入口で通すかを決める */
  admit(ip: string, bucket: RateBucket, now: number, count?: boolean): Promise<Admission>;
  /** 入口のほかで断った 401 と 403 を 1 回数える */
  countDenied(now: number): Promise<null>;
  /** ログインの証明かパスキーの失敗を 1 回数える */
  fail(ip: string, now: number): Promise<{ locked: boolean }>;
  /** challenge をログインセッションに結ぶ */
  putChallenge(sessionId: string, challenge: Challenge, now: number): Promise<null>;
  /** challenge を取り出して消す */
  takeChallenge(sessionId: string, now: number): Promise<Challenge | null>;
  /** 全体とサービスの出来事を数える */
  observe(event: unknown, now: number, thresholds: unknown): Promise<Observed>;
  /** 外の鍵を入れ直すまで使えない印を付ける */
  holdKeys(): Promise<null>;
  /** 外の鍵が使えない印が付いているか */
  keysHeld(): Promise<boolean>;
  /** 入れ直す鍵の今と、印を付けた世代 */
  keyState(): Promise<KeyState>;
  /** 入れ直した鍵の印を外す。読んだ世代が今と違えば何も変えない */
  releaseKeys(kind: KeyKind, generation: number): Promise<GuardKeys>;
  /** 今の基準のハッシュを置き換える。基準を変えるルートだけが呼ぶ */
  setThresholdHash(hash: string): Promise<null>;
  /** 今の基準のハッシュ。基準を一度も変えていなければ null */
  thresholdHash(): Promise<string | null>;
  /** その範囲と相手を止める権利を取る */
  claimStop(scope: string, target: string, stopId: string): Promise<boolean>;
  /** 止めた記録を再開する権利を取る */
  releaseStop(stopId: string): Promise<boolean>;
  /** 再開が途中で失敗した時に、再開する権利を返す */
  restoreStop(scope: string, target: string, stopId: string): Promise<null>;
  /** 記録を残せなかった時に、止める権利を返す */
  dropClaim(stopId: string): Promise<null>;
}

/** 社員 DO の RPC。時刻は呼ぶ側の Clock で渡す。入力は DO の中で Zod で確かめる (社員と勤怠の 2 章) */
export interface Staff extends Rpc.DurableObjectBranded {
  /** その時刻までに来た出来事を処理する */
  wake(now: number): Promise<null>;
  /** 今の状態を返す */
  status(now: number): Promise<StaffStatus>;
  /** 始まりの時刻を処理し終えた日の印を消して出来事を処理する。開発の通しが同じ日に流し直す時だけ使う */
  forgetDay(now: number): Promise<null>;
  /** ワークスペースのハートビートを受ける */
  heartbeat(at: number): Promise<null>;
  /** チェックポイントを受ける */
  checkpoint(input: unknown, now: number): Promise<null>;
  /** 新しいタスクを取るかを決める */
  take(task: unknown, medianMs: number | null, now: number): Promise<{ taken: boolean }>;
  /** 今のタスクを離れる */
  finish(result: unknown, now: number): Promise<null>;
  /** 勤務中で手が空いていれば、自分の山から次のタスクを取り、取ったら呼び出しを始める */
  pull(now: number, traceId?: string): Promise<{ taken: boolean; nodeId: string | null }>;
  /** alarm が無ければ掛け、持っているタスクの呼び出しが始まっていなければ始める */
  arm(now: number): Promise<{ alarm: number | null }>;
  /** 今のタスクの呼び出しの様子 */
  runState(nodeId: string): Promise<{ promptVersion: number | null; started: boolean; failures: number }>;
  /** 呼び出しの様子を書き、失敗の回数を返す */
  markRun(nodeId: string, mark: "started" | "failed" | "done"): Promise<{ failures: number }>;
  /** その日だけの指示を受ける */
  order(order: unknown, now: number): Promise<null>;
  /** 時間外に呼び出す。呼び出したかを返し、話しかけた時は 1 日の回数の上限を渡す */
  call(task: unknown, now: number, traceId?: string, limit?: { perDay: number }): Promise<boolean>;
  /** API の上限で待ち始める */
  waitStart(reason: unknown, now: number): Promise<null>;
  /** API の上限の待ちを解き、待っていた時間を返す */
  waitEnd(now: number): Promise<{ waitedMs: number | null }>;
  /** 自動停止で止める */
  stop(now: number): Promise<null>;
  /** 止めていたのを再開する */
  resume(now: number): Promise<null>;
  /** 勤怠の行を訂正する */
  correct(originalId: string, input: unknown, now: number): Promise<{ id: string }>;
  /** 社員とタスクの出来事を数える */
  observe(event: unknown, now: number, thresholds: unknown): Promise<Observed>;
  /** 止めたタスクを離れ、その作業トークンを失効させる */
  dropTask(nodeId: string, now: number): Promise<null>;
  /** 社員を止め、作業トークンをすべて失効させ、ワークスペースを作り直す */
  halt(now: number): Promise<null>;
  /** 再開したタスクの数を 0 に戻す */
  resumeTask(nodeId: string): Promise<null>;
  /** 今のタスクの働いた時間 */
  taskClock(now: number): Promise<{ nodeId: string; activeMs: number } | null>;
  /** タスクが読んだ外部の文章の出所 */
  externalSources(nodeId: string): Promise<string[]>;
  /** タスクの作業トークンを発行する */
  issueToken(nodeId: string, workspaceId: string, now: number, traceId?: string | null): Promise<IssuedTicket>;
  /** 残りが 10 分を切った作業トークンを発行し直す */
  renewToken(nodeId: string, workspaceId: string, now: number): Promise<RenewedTicket | null>;
  /** 作業トークンを ID で失効させる */
  revokeTokens(jtis: string[]): Promise<null>;
  /** タスクの作業トークンを、残す 1 本のほかすべて失効させる */
  revokeOthers(nodeId: string, keepJti: string): Promise<string[]>;
  /** 作業トークンが使えるかを確かめる */
  checkToken(jti: string, workspaceId: string, now: number): Promise<TicketCheck>;
  /** 1 日の集計を作り直す */
  rebuildDay(day: unknown, now: number): Promise<null>;
  /** 会話の記録の続きを暗号にして置く */
  appendTranscript(nodeId: string, input: unknown, now: number): Promise<null>;
  /** タスクの最後の session の会話の記録を復号して返す */
  loadTranscript(nodeId: string): Promise<RestoreInput | null>;
}

/** 配信 DO の RPC。全体で 1 つ。画面の WebSocket を休ませる形で持ち、出来事を配る (社員と自動の 3.7) */
export interface Live extends Rpc.DurableObjectBranded {
  /** 60 秒のうちに 1 回だけ使える作業トークンを出す */
  issue(now: number): Promise<{ ticket: string; expiresAt: string }>;
  /** 作業トークンを使った事にする */
  redeem(ticket: string, now: number): Promise<boolean>;
  /** 出来事を開いている WebSocket に配る。形は呼ぶ側の announce で確かめる */
  publish(event: unknown): Promise<null>;
  /** そのログインセッションの WebSocket を閉じる */
  closeSession(sessionId: string): Promise<null>;
  /** その送信元の WebSocket を閉じる */
  closeIp(ip: string): Promise<null>;
  /** すべての WebSocket を閉じる。except のログインセッションの物は残す */
  closeAll(except: string | null): Promise<null>;
  /** 開いたエディタの補完の接続を、同時の数に入れる。配信と合わせて超えた分は古い配信から閉じる */
  holdLsp(staffId: string, openedAt: number): Promise<null>;
  /** 閉じたエディタの補完の接続を、同時の数から外す */
  releaseLsp(staffId: string, openedAt: number): Promise<null>;
}

/** ワークスペースのコンテナの DO の RPC。社員 1 人に 1 つ */
export interface WorkspaceContainer extends Rpc.DurableObjectBranded {
  /** コンテナを起こし、/v1/health が返るまで待つ */
  start(staffId: string): Promise<null>;
  /** コンテナを止める */
  stop(): Promise<null>;
  /** コンテナを止めて起こし直す */
  restart(staffId: string): Promise<null>;
  /** 経過を書き残させる。走っている呼び出しを止め、送っていない会話の記録を送らせる */
  wrapUp(): Promise<null>;
  /** 走っている呼び出しを止めさせる。送っていない会話の記録を送らせ、止めた呼び出しの結果は送らせない */
  abort(reason: string): Promise<null>;
  /** タスク 1 件分の SDK の呼び出しを始めさせる */
  run(input: unknown): Promise<null>;
  /** 走っている呼び出しにオーナーの発言を足させる。止まっていれば起こさずに false、受けたら true */
  message(input: unknown): Promise<boolean>;
  /** 作業トークンを差し替えさせる */
  replaceTicket(ticket: string): Promise<null>;
  /** 会話の記録を SDK の置き場に戻させる */
  restore(input: unknown): Promise<null>;
  /** 起こした時に渡した鍵と同じかを確かめる。開発の代わりのワークスペースのハートビートを、その社員の物と決めるのに使う */
  holdsKey(key: string): Promise<boolean>;
  /** エディタの補完の接続の前の支度。止まっていて wake なら 1 回だけ起こし、木が今の先でなければ取る役を 1 本にだけ渡す (needed) */
  lspPrepare(input: unknown): Promise<LspPrepared>;
  /** 取った木 (tar.gz) をワークスペースに渡す */
  lspPutTree(nodeId: string, sha: string, claim: string, body: ReadableStream<Uint8Array>): Promise<null>;
  /** 木を取れなかった。待っている接続に取りに行かせる */
  lspDropTree(nodeId: string, sha: string, claim: string): Promise<null>;
  /** 合うエディタの補完の接続を閉じる */
  closeLsp(filter: unknown): Promise<null>;
  /** 補完で起こした物の期限を確かめ、過ぎていれば止める。社員 DO の 5 分の arm が呼ぶ */
  sweepEditor(now: number): Promise<null>;
}

/** 記録を年ごとに置く D1 のバインディングの名前。詳細設計の目次の 3.3 */
export const RECORD_BINDINGS = ["REC_2026", "REC_2027", "REC_2028", "REC_2029", "REC_2030", "REC_2031"] as const;

/** 記録の D1 のバインディングの名前 */
export type RecordBinding = (typeof RECORD_BINDINGS)[number];

/** Worker のバインディングと変数。wrangler の設定と同じ名前にする (詳細設計の目次の 3.3) */
export type Bindings = {
  /** 今の状態の D1 */
  DB: D1Database;
  /** 記録 DO */
  RECORDER: DurableObjectNamespace<Recorder>;
  /** 全体のセキュリティ DO */
  GUARD: DurableObjectNamespace<Guard>;
  /** 社員 DO。社員 ID ごとに 1 つ */
  STAFF: DurableObjectNamespace<Staff>;
  /** ワークスペースのコンテナの DO。社員 ID ごとに 1 つ */
  WORKSPACE: DurableObjectNamespace<WorkspaceContainer>;
  /** 配信 DO。全体で 1 つ */
  LIVE: DurableObjectNamespace<Live>;
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
  /** デプロイの後の確かめに使う Access の作業用の鍵の Client ID。稼働確認のルートだけ、この鍵の証明を通す */
  ACCESS_SMOKE_CLIENT_ID?: string;
  /** vault の鍵を暗号にする主の鍵。32 バイトを base64 で */
  MASTER_KEY: string;
  /** 会話の記録、社員が作ったファイル、D1 の毎日の写しを置く R2 */
  FILES: R2Bucket;
  /** Claude API の鍵。シークレットで入れ、Claude のプロキシと週のバッチ処理だけが Secret に包んで使う */
  ANTHROPIC_API_KEY?: string;
  /** know-office 自身のリポジトリ (owner/name)。見つけて直す仕組みが Issue を置く。無い間は数えるだけ */
  OFFICE_REPO?: string;
  /** 急ぐ故障を見つけた時の調べ。費用が出るので、オーナーの はい の後に on にする。初期値は off */
  URGENT_SCAN?: string;
  /** 週に 1 度のアイデア出し。費用が出るので、オーナーの はい の後に on にする。初期値は off */
  IDEA_BATCH?: string;
  /** 週に 1 度の蒸留。費用が出るので、オーナーの はい の後に on にする。初期値は off */
  DISTILL_BATCH?: string;
  /** 週に 1 度の見つけて直す調べ。費用が出るので、オーナーの はい の後に on にする。初期値は off */
  FINDINGS_BATCH?: string;
  /** 勤務の外にエディタの補完でワークスペースを起こすか。Containers の費用が出るので、オーナーの はい の後に on にする。初期値は off */
  EDITOR_WAKE?: string;
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
    /** 自動停止が外へ頼む口。テストは代わりの物を渡す */
    guard: GuardDeps;
    /** GitHub を呼ぶ口。つなぐまでは呼ぶと断る */
    forge: Forge;
    /** GitHub の 1 時間の鍵を作るのに使う、fetch、時刻、ためる所 */
    github: TokenDeps;
    /** リポジトリのコミットの tarball を開く。エディタの補完の木に使う */
    archive: (repo: string, sha: string) => Promise<ReadableStream<Uint8Array>>;
    /** 断った返事を、入口で 401、403、429 の数に入れたか。入れていればもう数えない */
    deniedCounted: boolean;
  };
};
