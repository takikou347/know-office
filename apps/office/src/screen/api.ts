// 画面から入口を呼ぶ口。道と返す形は入口の型から決まる
import { VISIT_HEADER } from "@know-office/core";
import { hc } from "hono/client";
import { createContext } from "react";
import { z } from "zod";
import type { Gate } from "../gate/index.ts";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ProblemCode = z.object({ code: z.string() }).loose();

/**
 * 401 の返事が、ログインセッションが無いか切れた時の物かを見る
 * @param res 返事
 * @returns unauthenticated の 401 か
 */
async function sessionMissing(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = ProblemCode.safeParse(await res.clone().json().catch(() => null));
  return body.success && body.data.code === "unauthenticated";
}

/**
 * ログインセッションが無いか切れた時に、POST /api/v1/sessions で作り直してから 1 度だけ呼び直す fetch を作る
 * @param base 入口の origin
 * @param fetcher 包む fetch
 * @returns 包んだ fetch
 */
export function sessionFetch(base: string, fetcher: Fetch = (input, init) => fetch(input, init)): Fetch {
  // 同時に落ちた呼び出しが、ログインセッションを 1 つだけ作るようにまとめる
  let signing: Promise<Response> | null = null;
  // ログインセッションを作り終えた回数。作る前に送った要求の 401 が後から届いた時に、もう 1 つ作らず呼び直すだけにする
  let signed = 0;
  return async (input, init) => {
    const sentAt = signed;
    const first = await fetcher(input, init);
    if (!(await sessionMissing(first))) return first;
    if (signed !== sentAt) return fetcher(input, init);
    signing ??= fetcher(`${base}/api/v1/sessions`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } })
      .then((res) => {
        if (res.ok) signed += 1;
        return res;
      })
      .finally(() => {
        signing = null;
      });
    const session = await signing;
    if (!session.ok) return session;
    return fetcher(input, init);
  };
}

/**
 * 画面を開いたのが訪問か (直に開いたか、ほかのサイトから来たか) を決める。Cloudflare Web Analytics の visit と同じく、referrer のホストが自分と違えば訪問
 * (https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/)
 * @param referrer document.referrer
 * @param host location.host
 * @returns 訪問か
 */
export function isVisit(referrer: string, host: string): boolean {
  if (referrer === "") return true;
  try {
    return new URL(referrer).host !== host;
  } catch {
    return true;
  }
}

/**
 * 画面が開いて最初の API の呼び出しだけに、訪問の印を付ける fetch を作る。referrer の文字列は送らない。
 * HTML が先読みした道 (<link rel=preload as=fetch>) は、最初の 1 度だけ印を付けずに呼ぶ。先読みは印を持たないので、印を付けると
 * ブラウザーが先読みの返事を使えば印が届かず、使わなければ 2 度読む。印はその次の呼び出しに付ける
 * @param fetcher 包む fetch
 * @param visit 訪問か
 * @param preloaded HTML が先読みした道 (絶対の URL)
 * @returns 包んだ fetch
 */
export function visitFetch(fetcher: Fetch, visit: boolean, preloaded: readonly string[] = []): Fetch {
  let pending = visit;
  const unused = new Set(preloaded);
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (unused.delete(url) || !pending) return fetcher(input, init);
    pending = false;
    const headers = new Headers(init?.headers);
    headers.set(VISIT_HEADER, "1");
    return fetcher(input, { ...init, headers });
  };
}

/**
 * 入口を呼ぶ口を作る
 * @param base 入口の origin
 * @param fetcher 包む fetch。無ければブラウザーの fetch
 * @param visit 画面を開いたのが訪問か。最初の呼び出しに印を付ける
 * @param preloaded HTML が先読みした道 (絶対の URL)。最初の 1 度は印を付けずに呼び、先読みの返事を使わせる
 * @returns Hono の RPC のクライアント
 */
export function createApi(base: string, fetcher?: Fetch, visit = false, preloaded: readonly string[] = []) {
  // ログインセッションを作り直して呼び直す時も同じ印が付くが、ゲートウェイはログインを通った呼び出しだけを数える
  return hc<Gate>(base, { fetch: visitFetch(sessionFetch(base, fetcher), visit, preloaded) });
}

/** 入口を呼ぶ口の型 */
export type Api = ReturnType<typeof createApi>;

/** 画面の部品が入口を呼ぶ口。サーバーで描く時とテストでは無い */
export const ApiContext = createContext<Api | null>(null);
