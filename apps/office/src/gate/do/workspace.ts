// ワークスペースのコンテナの DO と、コンテナの外向きの通信の受け手。判断は WorkspaceBox と routeEgress に置き、ここは包むだけ (社員が考えるの 3.2)
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AppError, StaffId, systemClock } from "@know-office/core";
import { z } from "zod";
import { routeEgress } from "../egress.ts";
import type { Bindings, WorkspaceContainer } from "../env.ts";
import { UNCONNECTED_DEPS } from "../guard/deps.ts";
import type { Caller } from "../work/ticket.ts";
import { announceNotice } from "../live/publish.ts";
import { containerFor } from "../work/dev-container.ts";
import { type ContainerLike, noticeWorkspaceDown, WorkspaceBox } from "../work/workspace-box.ts";

/** ワークスペースのサーバーの鍵を置く、記憶の鍵の名前 */
const WORKSPACE_KEY = "workspaceKey";

/** 受け手に結ぶ、送ったワークスペース。コンテナを起こした DO だけが決め、コンテナからは変えられない */
type EgressProps = Caller;

/** ワークスペースのコンテナの外向きの通信の受け手。Containers がコンテナの要求をここへ回す */
export class WorkspaceEgress extends WorkerEntrypoint<Bindings, EgressProps> {
  /**
   * コンテナから出た要求を、送ったワークスペースを結んでゲートウェイで受ける
   * @param request コンテナから出た要求
   * @returns 返事
   */
  override fetch(request: Request): Promise<Response> {
    return routeEgress(request, this.env, this.ctx.props, { clock: systemClock, guard: UNCONNECTED_DEPS, waitUntil: (p) => this.ctx.waitUntil(p) });
  }
}

/**
 * 待つ
 * @param ms ミリ秒
 * @returns 待ち終わり
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ワークスペースのコンテナの DO。`idFromName(<社員 ID>)` で社員 1 人に 1 つ。社員 DO とゲートウェイだけが RPC で呼ぶ */
export class WorkspaceDO extends DurableObject<Bindings> implements WorkspaceContainer {
  /** この DO のコンテナを包む物。起こしている途中の物を呼び出しの間で分け合うので、1 つだけ作る */
  #held: WorkspaceBox<Fetcher> | undefined;

  /**
   * コンテナを起こし、/v1/health が返るまで待つ
   * @param staffId 社員 ID
   * @returns 無し
   * @throws unavailable 起きなかった時
   */
  async start(staffId: string): Promise<null> {
    await this.#box(staffId).start();
    return null;
  }

  /**
   * コンテナを止める。起こしている途中なら、起こし終えてから止める
   * @returns 無し
   */
  async stop(): Promise<null> {
    await this.#box(await this.#staffId()).stop();
    return null;
  }

  /**
   * コンテナを止めて起こし直す。社員を止めた時とハートビートが途切れた時に呼ぶ
   * @param staffId 社員 ID
   * @returns 無し
   */
  async restart(staffId: string): Promise<null> {
    await this.stop();
    return this.start(staffId);
  }

  /**
   * 経過を書き残させてから、走っている呼び出しを止めさせる (POST /v1/abort)。退勤の前に呼ぶ。コンテナが止まっていれば何もしない
   * @returns 無し
   * @throws unavailable ワークスペースが答えない時
   */
  async wrapUp(): Promise<null> {
    await this.#box(await this.#staffId()).abort("wrap_up");
    return null;
  }

  /**
   * 走っている呼び出しを止めさせる (POST /v1/abort)。持っていたタスクが doing を離れた時に呼ぶ。コンテナが止まっていれば何もしない
   * @param reason 止める訳
   * @returns 無し
   * @throws unavailable ワークスペースが答えない時
   */
  async abort(reason: string): Promise<null> {
    await this.#box(await this.#staffId()).abort(reason);
    return null;
  }

  /**
   * タスク 1 件分の SDK の呼び出しを始めさせる
   * @param input RunInput
   * @returns 無し
   */
  async run(input: unknown): Promise<null> {
    await this.#box(await this.#staffId()).run(input);
    return null;
  }

  /**
   * 走っている呼び出しにオーナーの発言を足させる (POST /v1/messages)。コンテナが止まっていれば起こさずに false を返す
   * @param input WorkspaceMessageInput
   * @returns ワークスペースが受けたら true
   * @throws unavailable ワークスペースが答えない時
   */
  async message(input: unknown): Promise<boolean> {
    return this.#box(await this.#staffId()).message(input);
  }

  /**
   * 作業トークンを差し替えさせる
   * @param ticket 新しい作業トークン
   * @returns 無し
   */
  async replaceTicket(ticket: string): Promise<null> {
    await this.#box(await this.#staffId()).replaceTicket(ticket);
    return null;
  }

  /**
   * 復号した会話の記録を SDK の置き場に戻させる
   * @param input RestoreInput
   * @returns 無し
   */
  async restore(input: unknown): Promise<null> {
    await this.#box(await this.#staffId()).restore(input);
    return null;
  }

  /**
   * 動いているコンテナに起こした時に渡した鍵と同じかを確かめる。開発の代わりのワークスペースのハートビートを、その社員の物と決めるのに使う
   * @param key ワークスペースが示した鍵
   * @returns 同じなら true
   */
  async holdsKey(key: string): Promise<boolean> {
    return this.#box(await this.#staffId()).holdsKey(key);
  }

  /**
   * コンテナを包む。初めの 1 回だけ作り、後は同じ物を返す
   * @param staffId 社員 ID
   * @returns WorkspaceBox
   * @throws internal コンテナが無い (development の代わりも使えない)、社員 ID が違う時
   */
  #box(staffId: string): WorkspaceBox<Fetcher> {
    const parsed = StaffId.safeParse(staffId);
    if (!parsed.success || this.ctx.id.name !== parsed.data) throw new AppError("internal", "ワークスペースのコンテナが無い");
    if (this.#held) return this.#held;
    const caller: Caller = { staffId: parsed.data, workspaceId: this.ctx.id.toString() };
    // ctx.container は getTcpPort の Fetcher を返す。WorkspaceBox が使う fetch だけを持つ。手元の開発は Containers を切っているので、代わりのワークスペースに回す
    const real: ContainerLike<Fetcher> | undefined = this.ctx.container;
    const like = containerFor(this.env, real, parsed.data, (url, init) => fetch(url, init));
    const storage = this.ctx.storage;
    // 鍵は DO が起き直してもコンテナが動いている間は使うので、記憶に置く
    const keys = {
      get: async () => z.string().optional().parse(await storage.get(WORKSPACE_KEY)),
      put: (key: string) => storage.put(WORKSPACE_KEY, key),
    };
    this.#held = new WorkspaceBox(like, (props) => this.ctx.exports.WorkspaceEgress({ props }), caller, {
      wait: sleep,
      keys,
      notifyDown: async () => {
        const id = await noticeWorkspaceDown(this.env.DB, parsed.data, systemClock.now());
        if (id !== null) await announceNotice(this.env, id, systemClock);
      },
    });
    return this.#held;
  }

  /**
   * この DO の社員 ID を返す
   * @returns 社員 ID
   * @throws internal 分からない時
   */
  #staffId(): Promise<string> {
    const named = this.ctx.id.name;
    if (named === undefined) return Promise.reject(new AppError("internal", "ワークスペースの社員 ID が分からない"));
    return Promise.resolve(named);
  }
}
