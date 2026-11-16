// 通知: 一覧と既読 (サービスと拡張の 3.5、API の notices)
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
  summary: "通知",
  "x-steps": ["`cursor` を通知 ID として読む", "`notices` を新しい順に取得し、`cursor` の後から `limit` 件を返す"],
  "x-errors": ["400 `malformed_request`: `cursor` が通知 ID でない"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(Notice), ...problems(400, 401, 403, 422, 429, 500) },
});

const markNoticeReadRoute = createRoute({
  method: "put",
  path: "/api/v1/notices/{noticeId}/read",
  operationId: "markNoticeRead",
  tags: ["notices"],
  summary: "通知を既読にする",
  "x-steps": ["`read_at` を設定する。既読なら何もしない"],
  "x-errors": ["404 `not_found`: 通知が存在しない"],
  request: { params: z.object({ noticeId: z.uuid().openapi({ param: { name: "noticeId", in: "path" }, description: "UUID v7" }) }).strict() },
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
