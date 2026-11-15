// 配信: 作業トークンと WebSocket への切り替え (社員と自動の 3.7、ルートの一覧の 1.6)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, LiveTicket } from "@know-office/core";
import { createMiddleware } from "hono/factory";
import { createRouter } from "../app.ts";
import { currentSession } from "./sessions.ts";
import type { GateEnv } from "../env.ts";
import { liveOf } from "../live/publish.ts";
import { okResponse, problems } from "../openapi.ts";
import { created } from "../respond.ts";

const router = createRouter();

/**
 * WebSocket の切り替えは GET なので sameOrigin が見ない。ここで Origin が自分と同じかを、入力の検証と作業トークンを使うより先に確かめる
 * @throws origin_mismatch Origin が無い、null、または自分と違う時
 */
const liveOrigin = createMiddleware<GateEnv>(async (c, next) => {
  // Access の後ろでは要求の URL が公開の URL なので、その origin と文字列で比べる。前方一致や末尾の違いを通さない
  if (c.req.header("Origin") !== new URL(c.req.url).origin) throw new AppError("origin_mismatch", "Origin が異なる");
  await next();
});

const createLiveTicketRoute = createRoute({
  method: "post",
  path: "/api/v1/live/tickets",
  operationId: "createLiveTicket",
  tags: ["conversation"],
  responses: {
    201: { ...okResponse(LiveTicket, "作成した"), headers: { Location: { description: "作成したリソースの URL", schema: { type: "string" } } } },
    ...problems(401, 403, 429, 500),
  },
});

const openLiveRoute = createRoute({
  method: "get",
  path: "/api/v1/live",
  operationId: "openLive",
  tags: ["conversation"],
  middleware: [liveOrigin] as const,
  request: { query: z.object({ ticket: z.string().openapi({ param: { name: "ticket", in: "query", required: true } }) }).strict() },
  responses: { 101: { description: "WebSocket に切り替えた" }, ...problems(400, 401, 403, 422, 429, 500) },
});

/** 配信のルート */
export const liveRoutes = router
  .openapi(createLiveTicketRoute, async (c) => {
    currentSession(c);
    const data = await liveOf(c.env).issue(c.var.clock.now()).catch(rethrowLive);
    return created(c, data, "/api/v1/live");
  })
  .openapi(openLiveRoute, async (c) => {
    const session = currentSession(c);
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new AppError("malformed_request", "Upgrade: websocket が無い");
    const now = c.var.clock.now();
    const live = liveOf(c.env);
    // 作業トークンの中身はエラーの文にも入れない
    if (!(await live.redeem(c.req.valid("query").ticket, now))) throw new AppError("unauthenticated", "配信の作業トークンが使えない");
    const res = await live.fetch("https://live.internal/", { headers: { Upgrade: "websocket", "x-live-session": session.id, "x-live-ip": c.var.ip, "x-live-at": String(now) } });
    // DO の返事のヘッダーは変えられないので、セキュリティヘッダーを足せるよう、WebSocket だけを持つ返事に作り直す
    const init = { status: res.status, webSocket: res.webSocket };
    return new Response(null, init);
  });

/**
 * RPC を越えた rate_limited を AppError に戻す。ほかは投げ直す
 * @param error 投げられた物
 * @throws rate_limited 作業トークンが多すぎる時
 */
function rethrowLive(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "rate_limited") throw new AppError("rate_limited", "使える配信の作業トークンが多すぎる");
  throw error;
}
