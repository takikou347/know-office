// ワークスペースのコンテナの DO と、コンテナの外向きの通信の受け手。判断は WorkspaceBox と routeEgress に置き、ここは包むだけ (社員が考えるの 3.2)
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AppError, log, StaffId, systemClock } from "@know-office/core";
import { z } from "zod";
import { routeEgress } from "../egress.ts";
import type { Bindings, WorkspaceContainer } from "../env.ts";
import { UNCONNECTED_DEPS } from "../guard/deps.ts";
import type { Caller } from "../work/ticket.ts";
import { announceNotice, liveOf } from "../live/publish.ts";
import { EditorLsp } from "../work/editor-lsp.ts";
import type { RelaySocket, RelayTimers } from "../work/lsp-relay.ts";
import { containerFor } from "../work/dev-container.ts";
import { type ContainerLike, noticeWorkspaceDown, WorkspaceBox } from "../work/workspace-box.ts";

/** ワークスペースのサーバーの鍵を置く、記憶の鍵の名前 */
const WORKSPACE_KEY = "workspaceKey";
/** 社員 ID を置く、記憶の鍵の名前。alarm で起きた時は ctx.id.name が無いので読む */
const STAFF_KEY = "staffId";

/** 補完の支度の入力 */
const LspPrepareInput = z.object({ nodeId: z.string(), sha: z.string(), wake: z.boolean(), now: z.number().int() }).strict();
/** 補完の接続を閉じる相手 */
const LspCloseFilter = z.union([z.object({ sessionId: z.string() }).strict(), z.object({ ip: z.string() }).strict(), z.object({ except: z.string().nullable() }).strict()]);

/** DO の中の時計。中継の 1 時間と 10 分は DO が起きている間の setTimeout で数える。WebSocket を持つ間 DO は休まない */
const DO_TIMERS: RelayTimers = {
  now: () => systemClock.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * WebSocket で受けた 1 件を、文字かバイトに分ける。どちらでも無い物は空のバイトにし、中継が 1003 で閉じる
 * @param data 受けた物
 * @returns 文字かバイト
 */
function frameOf(data: unknown): string | ArrayBuffer {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  return new ArrayBuffer(0);
}

/**
 * workerd の WebSocket を中継の口にする
 * @param ws 受けた WebSocket
 * @returns 中継の口
 */
function relaySocket(ws: WebSocket): RelaySocket {
  return { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) };
}

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
  /** エディタの補完。1 つだけ作る */
  #editor: EditorLsp | undefined;

  /**
   * コンテナを起こし、/v1/health が返るまで待つ
   * @param staffId 社員 ID
   * @returns 無し
   * @throws unavailable 起きなかった時
   */
  async start(staffId: string): Promise<null> {
    const box = this.#box(staffId);
    // 出勤の start が来たら、補完で起こした物を勤務の物に替え、補完の期限で止めさせない
    await this.#editorOf(staffId).markShift();
    await box.start();
    return null;
  }

  /**
   * コンテナを止める。起こしている途中なら、起こし終えてから止める
   * @returns 無し
   */
  async stop(): Promise<null> {
    const staffId = await this.#staffId();
    await this.#editorOf(staffId).stopped();
    await this.#box(staffId).stop();
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
    const staffId = await this.#staffId();
    await this.#editorOf(staffId).markShift();
    await this.#box(staffId).run(input);
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
   * エディタの補完の接続の前の支度。止めている最中なら待ち、止まっていて wake なら 1 回だけ起こし、木が今の先でなければ取る役を 1 本にだけ渡す
   * @param input nodeId、sha、wake、now
   * @returns tree と woke
   * @throws validation_failed 形が違う時
   * @throws unavailable 止まっていて起こさない時、起きない時
   * @throws rate_limited 予算か tarball の回数を使い切った時
   */
  async lspPrepare(input: unknown): Promise<{ tree: "ready" | "needed"; woke: boolean }> {
    const parsed = LspPrepareInput.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "補完の支度の形が違う");
    return this.#editorOf(await this.#staffId()).prepare(parsed.data);
  }

  /**
   * 取った木をワークスペースに渡す
   * @param nodeId タスク
   * @param sha 先のコミット
   * @param body tar.gz
   * @returns 無し
   * @throws upstream_failed ワークスペースが木を断った時
   */
  async lspPutTree(nodeId: string, sha: string, body: ReadableStream<Uint8Array>): Promise<null> {
    return this.#editorOf(await this.#staffId()).putTree(nodeId, sha, body);
  }

  /**
   * 木を取れなかった。待っている接続に取りに行かせる
   * @param nodeId タスク
   * @param sha 先のコミット
   * @returns 無し
   */
  async lspDropTree(nodeId: string, sha: string): Promise<null> {
    return this.#editorOf(await this.#staffId()).dropTree(nodeId, sha);
  }

  /**
   * 合う補完の接続を閉じる。コンテナは起こさない
   * @param filter sessionId、ip、except のどれか
   * @returns 無し
   */
  async closeLsp(filter: unknown): Promise<null> {
    const parsed = LspCloseFilter.safeParse(filter);
    if (!parsed.success) throw new AppError("validation_failed", "閉じる相手の形が違う");
    this.#editor?.close(parsed.data);
    return null;
  }

  /**
   * 補完で起こした物の期限を確かめ、過ぎていれば止める。社員 DO の 5 分の arm が呼ぶので、alarm が消えても止める
   * @param now 今の時刻
   * @returns 無し
   */
  async sweepEditor(now: number): Promise<null> {
    await this.#editorOf(await this.#staffId()).sweep(now);
    return null;
  }

  /**
   * 補完で起こした物を止めるかを確かめる
   */
  override async alarm(): Promise<void> {
    // alarm は時刻を受けないので、ここだけ時計を読む
    await this.#editorOf(await this.#staffId()).alarm(systemClock.now());
  }

  /**
   * ゲートウェイが確かめた補完の切り替えを受け、ワークスペースの /v1/lsp に WebSocket を開いて中継する
   * @param request x-lsp-node、x-lsp-sha、x-lsp-session、x-lsp-ip、x-lsp-at を持つ要求
   * @returns 101。ワークスペースにつながらなければ 503
   */
  override async fetch(request: Request): Promise<Response> {
    const staffId = await this.#staffId();
    const editor = this.#editorOf(staffId);
    const header = (name: string) => request.headers.get(name) ?? "";
    const at = Number(header("x-lsp-at"));
    const meta = { sessionId: header("x-lsp-session"), ip: header("x-lsp-ip"), openedAt: Number.isSafeInteger(at) ? at : systemClock.now() };
    let res: Response;
    try {
      // getTcpPort().fetch に Upgrade: websocket を付けると、返事の webSocket でコンテナの WebSocket を受ける (Containers の getTcpPort)
      res = await this.#box(staffId).connectLsp(header("x-lsp-node"), header("x-lsp-sha"));
    } catch (error) {
      log("warn", "lsp_connect_failed", { staffId, error: error instanceof Error ? error.message : "unknown" });
      return new Response(null, { status: 503 });
    }
    const upstream = res.webSocket;
    if (res.status !== 101 || !upstream) {
      await res.body?.cancel();
      return new Response(null, { status: res.status === 404 ? 404 : 503 });
    }
    upstream.accept();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const relay = editor.attach(relaySocket(server), relaySocket(upstream), meta);
    server.addEventListener("message", (e) => relay.fromScreen(frameOf(e.data)));
    server.addEventListener("close", () => relay.screenClosed());
    server.addEventListener("error", () => relay.screenClosed());
    upstream.addEventListener("message", (e) => relay.fromUpstream(frameOf(e.data)));
    upstream.addEventListener("close", (e) => relay.upstreamClosed(e.code));
    upstream.addEventListener("error", () => relay.upstreamClosed(1011));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * エディタの補完を作る。初めの 1 回だけ作り、後は同じ物を返す
   * @param staffId 社員 ID
   * @returns EditorLsp
   */
  #editorOf(staffId: string): EditorLsp {
    if (this.#editor) return this.#editor;
    const box = this.#box(staffId);
    this.#editor = new EditorLsp({
      box,
      storage: { get: (key) => this.ctx.storage.get(key), put: (key, value) => this.ctx.storage.put(key, value) },
      timers: DO_TIMERS,
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      onRelayEnd: (meta) => {
        // 配信の同時の数から外す。届かなくても補完は止めない
        liveOf(this.env)
          .releaseLsp(staffId, meta.openedAt)
          .catch((error: unknown) => log("warn", "lsp_release_failed", { staffId, error: error instanceof Error ? error.message : "unknown" }));
      },
    });
    return this.#editor;
  }

  /**
   * コンテナを包む。初めの 1 回だけ作り、後は同じ物を返す
   * @param staffId 社員 ID
   * @returns WorkspaceBox
   * @throws internal コンテナが無い (development の代わりも使えない)、社員 ID が違う時
   */
  #box(staffId: string): WorkspaceBox<Fetcher> {
    const parsed = StaffId.safeParse(staffId);
    // alarm で起きた時は名前が無いので、記憶に置いた社員 ID と比べた物を受ける
    if (!parsed.success || (this.ctx.id.name !== undefined && this.ctx.id.name !== parsed.data)) throw new AppError("internal", "ワークスペースのコンテナが無い");
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
  async #staffId(): Promise<string> {
    const named = this.ctx.id.name;
    if (named !== undefined) {
      if ((await this.ctx.storage.get(STAFF_KEY)) !== named) await this.ctx.storage.put(STAFF_KEY, named);
      return named;
    }
    // alarm で起きた時は名前が無いので、前に置いた物を読む
    const stored = StaffId.safeParse(await this.ctx.storage.get(STAFF_KEY));
    if (!stored.success) throw new AppError("internal", "ワークスペースの社員 ID が分からない");
    return stored.data;
  }
}
