// 見つけて直す仕組みが作った、原因ごとの Issue の一覧 (ルートの一覧の 1.4、サービスと拡張の 3.7)
import { createRoute, z } from "@hono/zod-openapi";
import { Finding, FindingKind, FindingStatus } from "@know-office/core";
import { and, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { findings } from "../db/main.ts";
import { listQuery, listResponse, problems } from "../openapi.ts";
import { list } from "../respond.ts";

const router = createRouter();

const listFindingsRoute = createRoute({
  method: "get",
  path: "/api/v1/findings",
  operationId: "listFindings",
  tags: ["records"],
  request: {
    query: listQuery(router).extend({
      status: FindingStatus.optional().openapi({ param: { name: "status", in: "query" } }),
      // カーソルは findings の ID なので、UUID の形だけを受ける
      cursor: z.uuid().optional().openapi({ param: { name: "cursor", in: "query" }, description: "前のレスポンスの meta.next" }),
    }),
  },
  responses: { 200: listResponse(Finding), ...problems(400, 401, 403, 422, 429, 500) },
});

/** findings の行 */
type FindingRow = typeof findings.$inferSelect;

/**
 * findings の行を返す形に直す
 * @param row findings の行
 * @returns 原因ごとの Issue
 */
function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issueNumber,
    kind: FindingKind.parse(row.kind),
    count: row.count,
    firstAt: new Date(row.firstAt).toISOString(),
    lastAt: new Date(row.lastAt).toISOString(),
    status: FindingStatus.parse(row.status),
  };
}

/** 見つけて直す仕組みのルート */
export const findingRoutes = router.openapi(listFindingsRoute, async (c) => {
  const { status, cursor, limit } = c.req.valid("query");
  const rows = await drizzle(c.env.DB)
    .select()
    .from(findings)
    .where(and(status ? eq(findings.status, status) : undefined, cursor ? lt(findings.id, cursor) : undefined))
    .orderBy(desc(findings.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return list(c, page.map(toFinding), rows.length > limit ? (page.at(-1)?.id ?? null) : null);
});
