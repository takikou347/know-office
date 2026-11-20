// Web アプリのサービスが、訪問とアプリの 5xx を Workers Analytics Engine の共通のデータセットに書く共有の型 (サービスと拡張の 3.2)
// 依存を持たず、Workers の fetch の形の関数を包むだけなので、Hono でも素の Worker でも使える

/**
 * 管理する Web アプリが点を書く、共通の Analytics Engine のデータセット。office は SQL API でこの名前を読む。
 * データセットは最初に書いた時に作られる: https://developers.cloudflare.com/analytics/analytics-engine/get-started/
 */
export const REQUESTS_DATASET = "knowidea_requests";

/** 1 点。index1 と blob1 は Worker のスクリプト名、double1 は訪問なら 1、double2 は 5xx なら 1 */
export type RequestPoint = { indexes?: string[]; blobs?: string[]; doubles?: number[] };

/** Analytics Engine のデータセットのうち、点を書く所だけ。Workers の AnalyticsEngineDataset がそのまま入る */
export type RequestsDataset = {
  /**
   * 1 点を書く。待たずに Workers が裏で書く
   * @param point 書く点
   */
  writeDataPoint(point?: RequestPoint): void;
};

/** 共有の型が読むバインディング。wrangler.template.jsonc のとおりに置く */
export type RequestsEnv = {
  /** 共通のデータセット (knowidea_requests)。無い間は何も書かない */
  REQUESTS?: RequestsDataset;
  /** 点に書く、この Worker のスクリプト名。wrangler の name と同じ値で、プレビューは別の名前。無い間は何も書かない */
  WORKER_NAME?: string;
};

/** 包む前と後の Worker の fetch */
export type FetchHandler<E, C> = (request: Request, env: E, ctx: C) => Response | Promise<Response>;

/** 共有の型の設定 */
export type CountOptions = {
  /** 訪問かを決める。初期値は isVisitNavigation */
  visit?: (request: Request) => boolean;
  /** 点を書けなかった時に呼ぶ。応えは変えない */
  onWriteError?: (error: unknown) => void;
};

/**
 * アプリが返した 5xx か。500 から 599 だけで、429 や 401 などの 4xx は数えない
 * @param status 応えの HTTP ステータス
 * @returns 5xx か
 */
export function isServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * ページを直に開いたか、ほかのサイトから開いた読み込みか。Cloudflare Web Analytics の visit と同じ定め (referrer のホストが自分と違うか空)。
 * ブラウザーが付ける Sec-Fetch-Dest が document で Sec-Fetch-Mode が navigate の GET だけを見る。ページの中の呼び出し、iframe、フォームの POST、
 * Sec-Fetch の無い要求、形の違う Referer は数えない。偽っても訪問の数が増えるだけで、ほかの判断には効かない
 * 出典: https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/ 、https://www.w3.org/TR/fetch-metadata/
 * @param request 受けた要求
 * @returns 訪問か
 */
export function isVisitNavigation(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.get("sec-fetch-dest") !== "document" || request.headers.get("sec-fetch-mode") !== "navigate") return false;
  const referer = request.headers.get("referer");
  if (referer === null || referer === "") return true;
  if (!URL.canParse(referer)) return false;
  return new URL(referer).host !== new URL(request.url).host;
}

/**
 * 訪問か 5xx の呼び出しだけに 1 点書く。訪問で 5xx なら 1 点に両方を書く。
 * バインディングか WORKER_NAME が無い間は何もせず、書けない時は onWriteError を呼ぶだけで投げない。
 * 1 回の呼び出しで書ける点は 250 まで、index は 96 バイトまで: https://developers.cloudflare.com/analytics/analytics-engine/limits/
 * @param env バインディング
 * @param call 訪問か、5xx か
 * @param call.visit 訪問か
 * @param call.failed アプリが 5xx を返したか
 * @param onWriteError 書けなかった時に呼ぶ
 */
export function writeRequestPoint(env: RequestsEnv, call: { visit: boolean; failed: boolean }, onWriteError?: (error: unknown) => void): void {
  const dataset = env.REQUESTS;
  const script = env.WORKER_NAME ?? "";
  if (!dataset || script === "") return;
  if (!call.visit && !call.failed) return;
  try {
    dataset.writeDataPoint({ indexes: [script], blobs: [script], doubles: [call.visit ? 1 : 0, call.failed ? 1 : 0] });
  } catch (error) {
    onWriteError?.(error);
  }
}

/**
 * Worker の fetch を包み、応えを返した後に訪問か 5xx なら 1 点書く。
 * アプリが投げた失敗は Workers の errors に入るので数えずにそのまま投げ、二重に数えない。Hono は投げた失敗を 500 の応えに直すので、その 500 は数える
 * @param handler 包む fetch (Hono なら app.fetch)
 * @param options 訪問の決め方と、書けなかった時に呼ぶ物
 * @returns 包んだ fetch
 */
export function countRequests<E extends RequestsEnv, C>(handler: FetchHandler<E, C>, options: CountOptions = {}): FetchHandler<E, C> {
  const visitOf = options.visit ?? isVisitNavigation;
  return async (request, env, ctx) => {
    const visit = visitOf(request);
    const response = await handler(request, env, ctx);
    writeRequestPoint(env, { visit, failed: isServerError(response.status) }, options.onWriteError);
    return response;
  };
}
