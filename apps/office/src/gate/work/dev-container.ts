// 開発環境のワークスペースのコンテナの代わり。手元に Containers が無い時、代わりの物の置き場に立てた Node のワークスペースへ要求を回す (ログインと記録の 3.9、社員が考えるの 3.2)
import { AppError, StaffId, WORKSPACE_KEY_ENV } from "@know-office/core";
import { devWorkspaceBase, type EndpointEnv } from "../endpoints.ts";
import { type EgressOptions, routeEgress } from "../egress.ts";
import type { Bindings } from "../env.ts";
import { workspaceIdOf } from "./ticket.ts";
import type { ContainerLike } from "./workspace-box.ts";

/** 代わりのワークスペースがゲートウェイの受け手に送る道。/__dev/workspace/<社員 ID> の後に受け手の道を続ける */
const DEV_EGRESS = /^\/__dev\/workspace\/([^/]+)(\/ws\/v1\/.+)$/;

/** 代わりのワークスペースの SDK が呼ぶ Claude の道。/__dev/workspace/<社員 ID>/anthropic の後に Claude API の道を続ける */
const DEV_CLAUDE = /^\/__dev\/workspace\/([^/]+)\/anthropic(\/v1\/.+)$/;

/** ハートビートの道。代わりのワークスペースはワークスペースの鍵を付けて送る */
const HEARTBEAT_PATH = "/ws/v1/heartbeat";

/** 代わりのワークスペースを起こす時の待ち (10 秒) */
const BOOT_TIMEOUT_MS = 10_000;

/** 外への fetch。テストは代わりの物を渡す */
type DevFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 起こした代わりのワークスペース。社員 DO の入れ物が作り直されても、代わりのワークスペースは前の鍵で動き続けるので、入れ物の外 (この開発のサーバーの中) に覚える。
 * 開発のサーバーを起こし直すと代わりのワークスペースも消えるので、DO の記憶には置かない
 */
const RUNNING = new Set<string>();

/**
 * 開発のコンテナの代わり。外向きの通信の受け手は付けない。代わりのワークスペースはゲートウェイの開発の道 (devWorkspaceEgress) に送り、SDK の Claude の呼び出しもそこから Claude のプロキシに回る
 */
export class DevContainer<F = unknown> implements ContainerLike<F> {
  /** 受け手を作らない。代わりのワークスペースはゲートウェイの開発の道に直に送る */
  readonly intercepts = false;
  /** 起こしている途中の物。Node のサーバーへの要求はこれを待つ */
  #booting: Promise<void> = Promise.resolve();

  /**
   * 社員 1 人の代わりのワークスペースを包む
   * @param base 代わりのワークスペースの置き場。devWorkspaceBase が確かめた物
   * @param staffId 社員 ID
   * @param fetcher 外への fetch
   */
  constructor(
    private readonly base: string,
    private readonly staffId: StaffId,
    private readonly fetcher: DevFetch,
  ) {}

  /**
   * 起こした物を覚える名前
   * @returns 置き場と社員 ID
   */
  get #id(): string {
    return `${this.base}/${this.staffId}`;
  }

  /**
   * 動いているか
   * @returns 起こしてから止めていなければ true
   */
  get running(): boolean {
    return RUNNING.has(this.#id);
  }

  /**
   * 代わりのワークスペースを、渡された鍵で起こさせる
   * @param options 起こす時の環境変数。ワークスペースの鍵だけを渡す
   * @param options.env 環境変数
   */
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void {
    RUNNING.add(this.#id);
    const key = options.env?.[WORKSPACE_KEY_ENV] ?? "";
    this.#booting = this.#post("boot", { key });
  }

  /**
   * 受け手は付けない。代わりのワークスペースはゲートウェイの開発の道に直に送る
   * @returns 無し
   */
  interceptOutboundHttp(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 受け手は付けない
   * @returns 無し
   */
  interceptOutboundHttps(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Node のサーバーへの要求を、代わりのワークスペースの置き場へ回す口を返す
   * @returns fetch を持つ口
   */
  getTcpPort(): { fetch(url: string, init?: RequestInit): Promise<Response> } {
    return {
      fetch: async (url, init) => {
        await this.#booting;
        // 補完の切り替えは木の名前をクエリで渡し、Upgrade: websocket のまま出す。workerd の fetch は 101 を受けると webSocket を返す
        const { pathname, search } = new URL(url);
        return this.fetcher(`${this.base}/${this.staffId}${pathname}${search}`, init);
      },
    };
  }

  /**
   * 代わりのワークスペースを止める
   */
  async destroy(): Promise<void> {
    RUNNING.delete(this.#id);
    await this.#booting.catch(() => undefined);
    await this.#post("stop", {});
  }

  /**
   * 代わりのワークスペースの置き場に頼む
   * @param action boot か stop
   * @param body 本文
   * @throws unavailable 届かない時
   */
  async #post(action: "boot" | "stop", body: unknown): Promise<void> {
    const res = await this.fetcher(`${this.base}/${this.staffId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BOOT_TIMEOUT_MS),
    });
    if (!res.ok) throw new AppError("unavailable", `代わりのワークスペースが ${String(res.status)} を返した`);
  }
}

/**
 * DO のコンテナを返す。Containers が無い時は、development の時だけ代わりのワークスペースを使う
 * @param env 変数
 * @param real DO の ctx.container
 * @param staffId 社員 ID
 * @param fetcher 代わりのワークスペースへの fetch
 * @returns コンテナ
 * @throws internal コンテナが無く、development でない時か DEV_FAKES_URL が手元の宛先でない時
 */
export function containerFor<F>(env: EndpointEnv, real: ContainerLike<F> | undefined, staffId: StaffId, fetcher: DevFetch): ContainerLike<F> {
  if (real) return real;
  // 本番、プレビュー、ENVIRONMENT の無い所では、コンテナが無ければ動かさない。代わりの宛先へ回さない
  return new DevContainer<F>(devWorkspaceBase(env), staffId, fetcher);
}

/**
 * 開発の代わりのワークスペースが送った要求と、その SDK の Claude の呼び出しを、その社員のワークスペースの受け手に回す。代わりのワークスペースは Containers の外向きの通信を通らないので、ここで社員を道から決める
 * 道の社員は信じず、作業トークンが発行された先のワークスペースと合う時だけ受ける。ハートビートはワークスペースの鍵が合う時だけ受け、作業トークンの要らないほかの道 (チェックポイント) は受けない
 * @param request 入口に届いた要求
 * @param env バインディング
 * @param options 時刻と自動停止の口
 * @returns 受け手の返事。development でない時か、開発の道でない時は null で、ゲートウェイに任せる
 */
export function devWorkspaceEgress(request: Request, env: Bindings, options: EgressOptions): Promise<Response> | null {
  const url = new URL(request.url);
  const claude = DEV_CLAUDE.exec(url.pathname);
  const match = DEV_EGRESS.exec(url.pathname) ?? claude;
  if (!match || env.ENVIRONMENT !== "development") return null;
  // DEV_FAKES_URL が手元でなければ、代わりのワークスペースも無いので受けない。入口の fetch の中で投げず、断る返事にする
  try {
    devWorkspaceBase(env);
  } catch {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  const staffId = StaffId.safeParse(match[1]);
  const path = match[2] ?? "";
  if (!staffId.success) return Promise.resolve(new Response(null, { status: 404 }));
  // Claude の道は、コンテナの受け手が api.anthropic.com への要求を回すのと同じ形にして、作業トークンを確かめる Claude のプロキシに渡す
  const forwarded = new Request(`${claude ? "https://api.anthropic.com" : "http://gate.internal"}${path}${url.search}`, request);
  const caller = { staffId: staffId.data, workspaceId: workspaceIdOf(env, staffId.data) };
  if (path === HEARTBEAT_PATH) return devHeartbeat(forwarded, env, caller, options);
  return routeEgress(forwarded, env, caller, options);
}

/**
 * 開発の代わりのワークスペースのハートビートを受ける。道の社員は信じず、その社員のワークスペースの DO が起こした時に渡した鍵を示した時だけ、その社員のハートビートとして受け手に回す
 * 本物のコンテナは外向きの通信の受け手が社員を決めるが、代わりのワークスペースはそれを通らないので、鍵で決める
 * @param request ゲートウェイの受け手の道に直した要求
 * @param env バインディング
 * @param caller 道の社員とそのワークスペース
 * @param options 時刻と自動停止の口
 * @returns 受け手の返事。鍵が無いか違えば 401
 */
async function devHeartbeat(request: Request, env: Bindings, caller: { staffId: StaffId; workspaceId: string }, options: EgressOptions): Promise<Response> {
  const key = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const held = key !== undefined && (await env.WORKSPACE.get(env.WORKSPACE.idFromName(caller.staffId)).holdsKey(key));
  if (!held) return new Response(null, { status: 401 });
  const headers = new Headers(request.headers);
  // 受け手には鍵を渡さない。作業トークンと取り違えない
  headers.delete("authorization");
  return routeEgress(new Request(request, { headers }), env, caller, options);
}
