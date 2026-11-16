// 記録: 年ごとの置き場から読む監査ログとハッシュチェーンの確かめ、置き場ごとの使った量、月の稼働率 (ログインと記録の 3.4、3.5、サービスと拡張の 3.5)
import { createRoute, z } from "@hono/zod-openapi";
import { AppError, AuditRow, AuditVerification, jstDayStart, jstYear, RecordGroup, RecordSummary, StorageUse, Uptime, UptimeQuery, VerifyAuditInput } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { and, desc, gte, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { recordYears } from "../db/main.ts";
import { auditLog } from "../db/records.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { observe } from "../guard/observe.ts";
import { storageUses } from "../ledger/storage.ts";
import { monthUptime } from "../ledger/uptime.ts";
import { type RecordDb, type SummaryRange, summarize, summaryCsv } from "../ledger/summary.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";
import { rethrowRpc } from "../rpc.ts";

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
  summary: "監査ログ一覧",
  description: "15 分以内のパスキーの確認が必要。",
  "x-steps": ["指定期間に対応するデータベースを `record_years` から選ぶ", "`audit_log` を新しい順に取得する", "監査ログを閲覧したことを監査ログに記録する"],
  "x-errors": ["401 `step_up_required`: パスキーの確認がない", "422 `validation_failed`: `from` が `to` より後"],
  "x-step-up": true,
  middleware: [stepUpGate] as const,
  request: { query: listQuery(router).extend({ from: Day("from"), to: Day("to") }) },
  responses: { 200: listResponse(AuditRow), ...problems(400, 401, 403, 422, 429, 500) },
});

const verifyAuditLogsRoute = createRoute({
  method: "post",
  path: "/api/v1/audit-logs/verify",
  operationId: "verifyAuditLogs",
  tags: ["system"],
  summary: "1 年分の監査ログのハッシュチェーンを検証する",
  "x-steps": [
    "`RecorderDO.verify(year)` を呼ぶ",
    "ハッシュが一致しなければ、`guard.observe` に `chain_broken` を渡して全体を停止する",
    "結果 `ok` と、最初に一致しなかった行を返す",
  ],
  "x-errors": ["404 `not_found`: 指定した年のデータベースがない", "429 `rate_limited`: 同じ送信元から 1 分に 2 回目"],
  request: { body: { content: { "application/json": { schema: VerifyAuditInput } }, required: true } },
  responses: { 200: okResponse(AuditVerification), ...problems(400, 401, 403, 404, 413, 415, 422, 429, 500) },
});

const listStorageRoute = createRoute({
  method: "get",
  path: "/api/v1/storage",
  operationId: "listStorage",
  tags: ["system"],
  summary: "D1 データベースごとのストレージ使用量",
  "x-steps": ["`RecorderDO.size()` を呼ぶ", "データベースごとの使用量と、上限 10GB に対する割合を返す"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(StorageUse), ...problems(401, 403, 429, 500) },
});

const SummaryQuery = z
  .object({ from: Day("from"), to: Day("to"), group: RecordGroup.openapi({ param: { name: "group", in: "query", required: true } }) })
  .strict();

const getRecordSummaryRoute = createRoute({
  method: "get",
  path: "/api/v1/records/summary",
  operationId: "getRecordSummary",
  tags: ["records"],
  summary: "記録の集計",
  "x-steps": ["1 つの SQL で、`work_entries` と `usage` をスコープごとと全体で集計する"],
  request: { query: SummaryQuery },
  responses: { 200: okResponse(RecordSummary), ...problems(400, 401, 403, 422, 429, 500) },
});

const exportRecordSummaryRoute = createRoute({
  method: "get",
  path: "/api/v1/records/summary/export",
  operationId: "exportRecordSummary",
  tags: ["records"],
  summary: "記録の集計を CSV で出力する",
  "x-steps": ["`GET /api/v1/records/summary` と同じ集計を CSV で返す"],
  request: { query: SummaryQuery },
  responses: { 200: { description: "CSV", content: { "text/csv": { schema: z.string() } } }, ...problems(400, 401, 403, 422, 429, 500) },
});

const getUptimeRoute = createRoute({
  method: "get",
  path: "/api/v1/records/uptime",
  operationId: "getUptime",
  tags: ["records"],
  summary: "月間の稼働率",
  "x-steps": ["日本時間の指定月の `health_checks` の件数と、通った件数を 1 つの SQL で数える", "通った割合を `ratio` で返す。確かめが 1 件も無い月は `null`"],
  request: { query: UptimeQuery },
  responses: { 200: okResponse(Uptime), ...problems(400, 401, 403, 422, 429, 500) },
});

/**
 * 日本時間の日の期間を、時刻の期間にする
 * @param from 始めの日
 * @param to 終わりの日
 * @returns 日と時刻の期間
 * @throws validation_failed from が to より後の時
 */
function rangeOf(from: string | undefined, to: string | undefined): SummaryRange {
  if (from && to && from > to) throw new AppError("validation_failed", "from が to より後", { errors: [{ pointer: "#/query/from", detail: "to より前の日にする" }] });
  return { from: from ?? null, to: to ?? null, start: from ? jstDayStart(from) : null, end: to ? jstDayStart(to) + DAY : null };
}

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

/**
 * バインドした REC_<年> を年と並べる
 * @param env バインディング
 * @returns 年とその D1
 */
function boundRecords(env: Bindings): RecordDb[] {
  return RECORD_BINDINGS.flatMap((name) => {
    const db = env[name];
    return db ? [{ year: Number(name.slice("REC_".length)), db }] : [];
  });
}

/** 記録のルート: 監査ログの確かめと一覧、置き場ごとの使った量、記録の集計 */
export const recordRoutes = router
  .openapi(verifyAuditLogsRoute, async (c) => {
    const { year } = c.req.valid("json");
    const check = await c.env.RECORDER.get(c.env.RECORDER.idFromName("recorder")).verify(year).catch(rethrowRpc);
    // つなぎが合わない事は確かな不正なので、返す前に全体を止める。ログインと記録の 3.4 の 4
    if (!check.ok) await observe(c.env, { type: "chain_broken", year }, c.var.clock.now(), c.var.guard, c.var.traceId);
    return ok(c, { ok: check.ok, brokenAt: check.brokenAt });
  })
  .openapi(listAuditLogsRoute, async (c) => {
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
  })
  .openapi(getRecordSummaryRoute, async (c) => {
    const { from, to, group } = c.req.valid("query");
    return ok(c, await summarize(c.env.DB, boundRecords(c.env), group, rangeOf(from, to)));
  })
  .openapi(exportRecordSummaryRoute, async (c) => {
    const { from, to, group } = c.req.valid("query");
    const summary = await summarize(c.env.DB, boundRecords(c.env), group, rangeOf(from, to));
    return c.body(summaryCsv(summary), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="records-${group}.csv"` });
  })
  .openapi(getUptimeRoute, async (c) => ok(c, await monthUptime(c.env, c.req.valid("query").month)));
