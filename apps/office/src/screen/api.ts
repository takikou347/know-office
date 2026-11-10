// 画面から入口を呼ぶ口。道と返す形は入口の型から決まる
import { hc } from "hono/client";
import type { Gate } from "../gate/index.ts";

export function createApi(base: string, fetcher?: typeof fetch) {
  return hc<Gate>(base, fetcher ? { fetch: fetcher } : undefined);
}
