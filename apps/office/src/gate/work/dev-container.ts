// 開発環境のワークスペースのコンテナの代わり。手元に Containers が無い時、代わりの物の置き場に立てた Node のワークスペースへ要求を回す (ログインと記録の 3.9、社員が考えるの 3.1)
import { AppError, StaffId, WORKSPACE_KEY_ENV } from "@know-office/core";
import { devWorkspaceBase, type EndpointEnv } from "../endpoints.ts";
import { type EgressOptions, OPEN_PATHS, routeEgress } from "../egress.ts";
import type { Bindings } from "../env.ts";
import { workspaceIdOf } from "./ticket.ts";
import type { ContainerLike } from "./workspace-box.ts";

/** 代わりのワークスペースがゲートウェイの受け手に送る道。/__dev/workspace/<社員 ID> の後に受け手の道を続ける */
const DEV_EGRESS = /^\/__dev\/workspace\/([^/]+)(\/ws\/v1\/.+)$/;

/** 代わりのワークスペースを起こす時の待ち (10 秒) */
const BOOT_TIMEOUT_MS = 10_000;

/** 外への fetch。テストは代わりの物を渡す */
type DevFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 開発のコンテナの代わり。外向きの通信の受け手は付けない (代わりのワークスペースはゲートウェイの受け手を通らない)
 * 代わりのワークスペースの SDK は、代わりの物の置き場の Claude API だけを呼ぶ
 */
export class DevContainer<F = unknown> implements ContainerLike<F> {
  #running = false;
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
   * 動いているか
   * @returns 起こしてから止めていなければ true
   */
  get running(): boolean {
    return this.#running;
  }

  /**
   * 代わりのワークスペースを、渡された鍵で起こさせる
   * @param options 起こす時の環境変数。ワークスペースの鍵だけを渡す
   * @param options.env 環境変数
   */
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void {
    this.#running = true;
    const key = options.env?.[WORKSPACE_KEY_ENV] ?? "";
    this.#booting = this.#post("boot", { key });
  }

  /**
   * 受け手は付けない。代わりのワークスペースはゲートウェイを通らずに代わりの物だけを呼ぶ
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
        const { pathname } = new URL(url);
        return this.fetcher(`${this.base}/${this.staffId}${pathname}`, init);
      },
    };
  }

  /**
   * 代わりのワークスペースを止める
   */
  async destroy(): Promise<void> {
    this.#running = false;
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
 * 開発の代わりのワークスペースが送った要求を、その社員のワークスペースの受け手に回す。代わりのワークスペースは Containers の外向きの通信を通らないので、ここで社員を道から決める
 * 道の社員は信じず、作業トークンが発行された先のワークスペースと合う時だけ受ける。作業トークンの要らない道 (ハートビート、チェックポイント) は受けない
 * @param request 入口に届いた要求
 * @param env バインディング
 * @param options 時刻と自動停止の口
 * @returns 受け手の返事。development でない時か、開発の道でない時は null で、ゲートウェイに任せる
 */
export function devWorkspaceEgress(request: Request, env: Bindings, options: EgressOptions): Promise<Response> | null {
  const url = new URL(request.url);
  const match = DEV_EGRESS.exec(url.pathname);
  if (!match || env.ENVIRONMENT !== "development") return null;
  // DEV_FAKES_URL が手元でなければ、代わりのワークスペースも無いので受けない。入口の fetch の中で投げず、断る返事にする
  try {
    devWorkspaceBase(env);
  } catch {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  const staffId = StaffId.safeParse(match[1]);
  const path = match[2] ?? "";
  if (!staffId.success || OPEN_PATHS.has(path)) return Promise.resolve(new Response(null, { status: 404 }));
  const forwarded = new Request(`http://gate.internal${path}${url.search}`, request);
  return routeEgress(forwarded, env, { staffId: staffId.data, workspaceId: workspaceIdOf(env, staffId.data) }, options);
}
