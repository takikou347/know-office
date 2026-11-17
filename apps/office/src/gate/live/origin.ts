// WebSocket の切り替えの Origin の確かめ。配信と補完が使う (API の決まりの 4.5)
import { AppError } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import type { GateEnv } from "../env.ts";

/**
 * WebSocket の切り替えは GET なので sameOrigin が見ない。ここで Origin が自分と同じかを、入力の検証と作業トークンを使うより先に確かめる
 * @throws origin_mismatch Origin が無い、null、または自分と違う時
 */
export const upgradeOrigin = createMiddleware<GateEnv>(async (c, next) => {
  // Access の後ろでは要求の URL が公開の URL なので、その origin と文字列で比べる。前方一致や末尾の違いを通さない
  if (c.req.header("Origin") !== new URL(c.req.url).origin) throw new AppError("origin_mismatch", "Origin が異なる");
  await next();
});
