// 通知: 一覧と既読 (サービスと拡張の 3.5、ルートの一覧の 1.13)
import { createRoute, z } from "@hono/zod-openapi";
import { Notice } from "@know-office/core";
import { createRouter } from "../app.ts";
import { listNotices, markNoticeRead } from "../ledger/notices.ts";
import { listQuery, listResponse, problems } from "../openapi.ts";
import { list, noContent } from "../respond.ts";

const router = createRouter();

const listNoticesRoute = createRoute({
  method: "get",
  path: "/api/v1/notices",
  operationId: "listNotices",
  tags: ["notices"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(Notice), ...problems(400, 401, 403, 422, 429, 500) },
});

const markNoticeReadRoute = createRoute({
  method: "put",
  path: "/api/v1/notices/{noticeId}/read",
  operationId: "markNoticeRead",
  tags: ["notices"],
  request: { params: z.object({ noticeId: z.uuid().openapi({ param: { name: "noticeId", in: "path" } }) }).strict() },
  responses: { 204: { description: "成功。レスポンス本文なし" }, ...problems(401, 403, 404, 429, 500) },
});

/** 通知のルート */
export const noticeRoutes = router
  .openapi(listNoticesRoute, async (c) => {
    const { items, next } = await listNotices(c.env.DB, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(markNoticeReadRoute, async (c) => {
    await markNoticeRead(c.env.DB, c.req.valid("param").noticeId, c.var.clock.now());
    return noContent(c);
  });
