// 記録: 年ごとの置き場から読む監査ログと、置き場ごとの使った量 (ログインと記録の 3.5)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, AuditRow, jstDayStart, jstYear, StorageUse } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { and, desc, gte, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { recordYears } from "../db/main.ts";
import { auditLog } from "../db/records.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { storageUses } from "../ledger/storage.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, problems } from "../openapi.ts";
import { list } from "../respond.ts";

const DAY = 24 * 60 * 60_000;
const router = createRouter();

/**
 * 期間の端に使う、日本時間の日のクエリ
 * @param name クエリの名前
 * @returns YYYY-MM-DD の省略できる Zod スキーマ
 */
const Day = (name: string) => z.iso.date().optional().openapi({ param: { name, in: "query" }, description: "日本時間の日付 YYYY-MM-DD" });

const listAuditLogsRoute = createRoute({
  method: "get",
  path: "/api/v1/audit-logs",
  operationId: "listAuditLogs",
  tags: ["system"],
  "x-step-up": true,
  request: { query: listQuery(router).extend({ from: Day("from"), to: Day("to") }) },
  responses: { 200: listResponse(AuditRow), ...problems(400, 401, 403, 422, 429, 500) },
});

const listStorageRoute = createRoute({
  method: "get",
  path: "/api/v1/storage",
  operationId: "listStorage",
  tags: ["system"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(StorageUse), ...problems(401, 403, 429, 500) },
});

/**
 * record_years の binding を、その年の置き場の D1 にする
 * @param env バインディング
 * @param binding REC_<年>
 * @returns その年の D1
 * @throws internal バインドされていない時
 */
function recordDb(env: Bindings, binding: string): D1Database {
  // record_years の値はそのまま env の鍵に使わず、決めた名前の並びと合う物だけを使う
  const name = RECORD_BINDINGS.find((b) => b === binding);
  const db = name ? env[name] : undefined;
  if (!db) throw new AppError("internal", `${binding} がバインドされていない`);
  return db;
}

/** 記録のルート: 監査ログの一覧と、置き場ごとの使った量 */
export const recordRoutes = router
  .openapi(listAuditLogsRoute, async (c) => {
    requireStepUp(c);
    const { from, to, cursor, limit } = c.req.valid("query");
    if (from && to && from > to) throw new AppError("validation_failed", "from が to より後", { errors: [{ pointer: "#/query/from", detail: "to より前の日にする" }] });
    // 日本時間の日で受け、その日の 0 時から、to の次の日の 0 時の前までを読む
    const start = from ? jstDayStart(from) : 0;
    const end = to ? jstDayStart(to) + DAY : null;
    const years = await drizzle(c.env.DB)
      .select()
      .from(recordYears)
      .where(and(gte(recordYears.year, jstYear(start)), end === null ? undefined : lte(recordYears.year, jstYear(end - 1))))
      .orderBy(desc(recordYears.year));
    // ID は UUID v7 で書いた順に並び、後の年ほど大きい。新しい年から読み、limit を 1 件超えたら次のページがある
    const rows: (typeof auditLog.$inferSelect)[] = [];
    for (const year of years) {
      if (rows.length > limit) break;
      const found = await drizzle(recordDb(c.env, year.binding))
        .select()
        .from(auditLog)
        .where(and(gte(auditLog.at, start), end === null ? undefined : lt(auditLog.at, end), cursor ? lt(auditLog.id, cursor) : undefined))
        .orderBy(desc(auditLog.id))
        .limit(limit + 1 - rows.length);
      rows.push(...found);
    }
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
    await audit(c, "audit_log.read", null, { from: from ?? null, to: to ?? null });
    return list(
      c,
      page.map((row) => ({ ...row, at: new Date(row.at).toISOString(), detail: row.detail ?? null })),
      next,
    );
  })
  .openapi(listStorageRoute, async (c) => {
    const { cursor, limit } = c.req.valid("query");
    // 置き場は数個なので全部を測ってから、名前の順のカーソルで切る
    const uses = (await storageUses(c.env)).filter((use) => cursor === undefined || use.binding > cursor);
    const page = uses.slice(0, limit);
    const next = uses.length > limit ? (page.at(-1)?.binding ?? null) : null;
    return list(c, page, next);
  });
