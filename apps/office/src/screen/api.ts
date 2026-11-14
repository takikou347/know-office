// 画面から入口を呼ぶ口。道と返す形は入口の型から決まる
import { hc } from "hono/client";
import { createContext } from "react";
import { z } from "zod";
import type { Gate } from "../gate/index.ts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  return async (input, init) => {
    const first = await fetcher(input, init);
    if (!(await sessionMissing(first))) return first;
    signing ??= fetcher(`${base}/api/v1/sessions`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } }).finally(() => {
      signing = null;
    });
    const session = await signing;
    if (!session.ok) return session;
    return fetcher(input, init);
  };
}

/**
 * 入口を呼ぶ口を作る
 * @param base 入口の origin
 * @param fetcher 包む fetch。無ければブラウザーの fetch
 * @returns Hono の RPC のクライアント
 */
export function createApi(base: string, fetcher?: Fetch) {
  return hc<Gate>(base, { fetch: sessionFetch(base, fetcher) });
}

/** 入口を呼ぶ口の型 */
export type Api = ReturnType<typeof createApi>;

/** 画面の部品が入口を呼ぶ口。サーバーで描く時とテストでは無い */
export const ApiContext = createContext<Api | null>(null);
