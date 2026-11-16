// 社員 1 人のワークスペースのコンテナを起こし、外向きの通信をゲートウェイの受け手だけに絞り、Node のサーバーを鍵を付けて呼ぶ。起きなければ知らせる (社員が考えるの 2 章、3.2)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, CONTAINER_CA, Health, log, newId, ReasonInput, RestoreInput, RunInput, type StaffId, TicketInput, WORKSPACE_KEY_ENV } from "@know-office/core";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { notices } from "../db/main.ts";
import { WORKSPACE_EGRESS, type Caller } from "../egress.ts";

/** ワークスペースの Node のサーバーの番号 */
export const WORKSPACE_PORT = 8080;
/** 起きるのを待つ長さ (60 秒)。1 秒おきに /v1/health を見る */
export const START_WAIT_MS = 60_000;
/** 起きなかった時のやり直しの間 (30 秒) */
export const START_RETRY_MS = 30_000;
/** 起きなかった時のやり直しの回数 (3 回)。初めの 1 回と合わせて 4 回起こす */
export const START_RETRIES = 3;
/** Node のサーバーを呼ぶ時の待ち (10 秒) */
const CALL_TIMEOUT_MS = 10_000;
/** 会話の記録を戻す時の待ち (60 秒)。記録の全部を 1 度に送るので、ほかの呼び出しより長く待つ */
const RESTORE_TIMEOUT_MS = 60_000;
/** 中断の待ち (60 秒)。ワークスペースは会話の記録を送り終えてから返すので、ほかの呼び出しより長く待つ */
const ABORT_TIMEOUT_MS = 60_000;
const POLL_MS = 1000;

const HealthAnswer = z.object({ data: Health }).loose();

/** WorkspaceBox の依り所。WorkspaceDO は DO の記憶と setTimeout、テストは代わりの物を渡す */
export type BoxDeps = {
  /** 待つ。テストは待たずに数える */
  wait(ms: number): Promise<void>;
  /** ワークスペースのサーバーの鍵を置く所。起こすたびに作り直し、コンテナが動いている間は同じ物を使う */
  keys: { get(): Promise<string | undefined>; put(key: string): Promise<void> };
  /** やり直しても起きなかった事をオーナーに知らせる */
  notifyDown(): Promise<void>;
};

/**
 * ワークスペースが起きなかった事を通知に出す。同じ社員の通知は、オーナーが読むまで重ねて出さない
 * @param db D1 の DB
 * @param staffId 社員 ID
 * @param now 今の時刻
 * @returns 足した通知の ID。もう出ていて足さなかった時は null
 */
export async function noticeWorkspaceDown(db: D1Database, staffId: StaffId, now: number): Promise<string | null> {
  const orm = drizzle(db);
  // 題は、同じ社員の通知を重ねないための鍵も兼ねる
  const title = `${staffId} のワークスペースが起きない`;
  const [open] = await orm
    .select({ id: notices.id })
    .from(notices)
    .where(and(eq(notices.kind, "workspace_down"), eq(notices.title, title), isNull(notices.readAt)))
    .limit(1);
  if (open) return null;
  const id = newId({ now: () => now });
  await orm.insert(notices).values({
    id,
    at: now,
    level: "warn",
    kind: "workspace_down",
    title,
    body: "4 回起こしても /v1/health が返らなかった。社員はワークスペースを待ち、ハートビートが届かない間は起こし直す",
    scope: "office",
  });
  return id;
}

/**
 * ワークスペースのサーバーの鍵を作る
 * @returns 32 バイトの乱数の 16 進
 */
function newWorkspaceKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** DO の ctx.container のうち使う所。テストは代わりの物を渡す */
export type ContainerLike<F = unknown> = {
  /** 動いているか */
  readonly running: boolean;
  /** 外向きの通信を受け手に回すか。開発のコンテナの代わりだけが false で、受け手を作らない。無ければ回す */
  readonly intercepts?: false;
  /** 起こす */
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void;
  /** その宛先の HTTP を受け手に回す */
  interceptOutboundHttp(host: string, fetcher: F): Promise<void>;
  /** その宛先の HTTPS を受け手に回す */
  interceptOutboundHttps(host: string, fetcher: F): Promise<void>;
  /** コンテナの番号に要求を出す口 */
  getTcpPort(port: number): { fetch(url: string, init?: RequestInit): Promise<Response> };
  /** 止める */
  destroy(): Promise<void>;
};

/**
 * 文字列の SHA-256 を返す。鍵を同じ長さにそろえて比べる
 * @param value 文字列
 * @returns 32 バイト
 */
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** 社員 1 人のワークスペースのコンテナ。WorkspaceDO が持ち、テストは代わりのコンテナで使う */
export class WorkspaceBox<F = unknown> {
  /** 起こしている途中の物。同じ時の start() はこれを待ち、鍵を作って置く順が食い違わないようにする */
  #starting: Promise<void> | undefined;

  /**
   * 社員 1 人のコンテナを、送ったワークスペースを結んだ受け手と一緒に包む
   * @param container コンテナ
   * @param egress 送ったワークスペースを結んだ、ゲートウェイの受け手を作る
   * @param caller このワークスペース
   * @param deps 待ち方と鍵を置く所
   */
  constructor(
    private readonly container: ContainerLike<F>,
    private readonly egress: (caller: Caller) => F,
    private readonly caller: Caller,
    private readonly deps: BoxDeps,
  ) {}

  /**
   * 外向きの通信を切って起こし、/v1/health が返るまで 60 秒待つ。起きなければ 30 秒おきに 3 回やり直し、それでも起きなければオーナーに知らせる
   * 起こしている途中に呼ばれたら、新しく起こさずに同じ物を待つ
   * @returns 起き終わり
   * @throws unavailable 4 回とも起きなかった時
   */
  start(): Promise<void> {
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /**
   * 起こす。start() だけが 1 本ずつ呼ぶ
   * @throws unavailable 4 回とも起きなかった時
   */
  async #start(): Promise<void> {
    for (let attempt = 0; attempt <= START_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await this.container.destroy();
        await this.deps.wait(START_RETRY_MS);
      }
      if (!this.container.running) await this.#boot();
      else if ((await this.deps.keys.get()) === undefined) {
        // 前から動いているコンテナの鍵が記憶に無ければ、呼べないので起こし直す
        await this.container.destroy();
        await this.#boot();
      }
      if (await this.#healthy()) return;
      log("warn", "workspace_start_slow", { staffId: this.caller.staffId, attempt });
    }
    log("error", "workspace_start_failed", { staffId: this.caller.staffId });
    // 知らせられなくても、起きなかった事は呼んだ側に返す
    await this.deps.notifyDown().catch((error: unknown) => log("warn", "workspace_notice_failed", { staffId: this.caller.staffId, error: error instanceof Error ? error.message : "unknown" }));
    throw new AppError("unavailable", "ワークスペースが起きない");
  }

  /**
   * 止める。起こしている途中なら、起こし終えてから止める。途中で止めると、やり直しで起こし直してしまう
   */
  async stop(): Promise<void> {
    await this.#starting?.catch(() => undefined);
    if (this.container.running) await this.container.destroy();
  }

  /**
   * タスク 1 件分の SDK の呼び出しを始めさせる。コンテナが止まっていれば起こしてから送る
   * @param input RunInput
   * @throws validation_failed 形が違う時
   * @throws conflict もう走っている時
   * @throws unavailable ワークスペースが起きない、答えない時
   */
  async run(input: unknown): Promise<void> {
    const parsed = RunInput.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "タスクの形が違う");
    // 記憶に鍵が残っていても、コンテナが止まっていれば届かない。起きている時は /v1/health を 1 度見るだけ
    await this.start();
    await this.#call("POST", "/v1/runs", parsed.data, 202);
  }

  /**
   * 動いているコンテナに起こした時に渡した鍵と同じかを確かめる。SHA-256 にそろえてから全部のバイトを比べ、どこで違うかで時間を変えない
   * @param key ワークスペースが示した鍵
   * @returns 同じなら true。止まっているか、鍵が記憶に無ければ false
   */
  async holdsKey(key: string): Promise<boolean> {
    const held = this.container.running ? await this.deps.keys.get() : undefined;
    if (held === undefined) return false;
    const [a, b] = await Promise.all([digest(held), digest(key)]);
    let diff = 0;
    for (const [i, byte] of a.entries()) diff |= byte ^ (b[i] ?? 0);
    return diff === 0;
  }

  /**
   * 走っている呼び出しを止めさせる。ワークスペースは会話の記録を送ってから止め、結果を送らない。止まっているコンテナは起こさない
   * @param reason 止める訳
   * @throws unavailable ワークスペースが答えない時
   */
  async abort(reason: string): Promise<void> {
    await this.#starting?.catch(() => undefined);
    if (!this.container.running || (await this.deps.keys.get()) === undefined) return;
    await this.#call("POST", "/v1/abort", ReasonInput.parse({ reason }), 204, ABORT_TIMEOUT_MS);
  }

  /**
   * 作業トークンを差し替えさせる
   * @param ticket 新しい作業トークン
   * @throws unavailable ワークスペースが答えない時
   */
  async replaceTicket(ticket: string): Promise<void> {
    await this.#call("PUT", "/v1/ticket", TicketInput.parse({ ticket }), 204);
  }

  /**
   * 復号した会話の記録を SDK の置き場に戻させる。続きを呼ぶ前に行う
   * @param input RestoreInput
   * @throws validation_failed 形が違う時
   * @throws conflict 走っている時
   * @throws unavailable ワークスペースが答えない時
   */
  async restore(input: unknown): Promise<void> {
    const parsed = RestoreInput.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "会話の記録の形が違う");
    await this.#call("POST", "/v1/restore", parsed.data, 204, RESTORE_TIMEOUT_MS);
  }

  /**
   * 受け手を付けてからコンテナを起こす。受け手を付けない宛先には、外向きの通信を切るので出られない
   * ワークスペースのサーバーはコンテナの中の社員からも届くので、起こすたびに鍵を作って渡し、この鍵の無い要求を断らせる
   * 社員はサーバーと同じ uid で動き、/proc とメモリから鍵を読めるので、防ぐのは鍵を知らずに 8080 番を直に呼ぶ事だけ
   */
  async #boot(): Promise<void> {
    // 開発のコンテナの代わりは受け手を通らない。手元の開発のサーバーは起こした直後に ctx.exports の受け手をまだ持たないので、作らずに起こす
    if (this.container.intercepts !== false) {
      const fetcher = this.egress(this.caller);
      for (const host of WORKSPACE_EGRESS.http) await this.container.interceptOutboundHttp(host, fetcher);
      for (const host of WORKSPACE_EGRESS.https) await this.container.interceptOutboundHttps(host, fetcher);
    }
    // ゲートウェイの鍵は渡さない。作業トークンは /v1/runs で渡す
    const key = newWorkspaceKey();
    await this.deps.keys.put(key);
    this.container.start({ enableInternet: false, env: { NODE_EXTRA_CA_CERTS: CONTAINER_CA, [WORKSPACE_KEY_ENV]: key } });
  }

  /**
   * /v1/health が返るまで 1 秒おきに 60 秒見る
   * @returns 起きたか
   */
  async #healthy(): Promise<boolean> {
    for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
      try {
        const res = await this.container.getTcpPort(WORKSPACE_PORT).fetch("http://workspace/v1/health", { signal: AbortSignal.timeout(POLL_MS) });
        if (res.ok && HealthAnswer.safeParse(await res.json()).success) return true;
      } catch {
        // 起きる前はつながらない
      }
      await this.deps.wait(POLL_MS);
    }
    return false;
  }

  /**
   * Node のサーバーを呼ぶ
   * @param method メソッド
   * @param path 道
   * @param body 本文
   * @param expected 成功のステータス
   * @param timeoutMs 待つ長さ
   * @throws conflict 409 が返った時
   * @throws unavailable 鍵が無い、届かない、ほかのステータスの時
   */
  async #call(method: string, path: string, body: unknown, expected: number, timeoutMs = CALL_TIMEOUT_MS): Promise<void> {
    let key = await this.deps.keys.get();
    if (key === undefined) {
      await this.start();
      key = await this.deps.keys.get();
    }
    if (key === undefined) throw new AppError("unavailable", "ワークスペースの鍵が無い");
    let res: Response;
    try {
      res = await this.container.getTcpPort(WORKSPACE_PORT).fetch(`http://workspace${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError("unavailable", "ワークスペースに届かない");
    }
    if (res.status === 409) throw new AppError("conflict", "ワークスペースがもう走っている");
    if (res.status !== expected) throw new AppError("unavailable", `ワークスペースが ${String(res.status)} を返した`);
  }
}
