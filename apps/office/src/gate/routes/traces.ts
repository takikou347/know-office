// エラーログの一覧と、traceId で 1 つの要求を追うルート。年ごとの置き場 REC_<年> から読む (ログインと記録の 3.6)
import { createRoute, z } from "@hono/zod-openapi";
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, ERROR_SOURCES, ErrorEvent, ErrorEventCode, jstDayStart, jstYear, redactText, Trace, TraceId } from "@know-office/core";
import { createRouter } from "../app.ts";
import { stepUpGate } from "../auth/passkey.ts";
import { type Bindings, RECORD_BINDINGS } from "../env.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";

const DAY = 24 * 60 * 60_000;
/** 会話の本文を追う画面に出す長さ */
const MESSAGE_HEAD = 80;
const router = createRouter();

const Day = (name: string) => z.iso.date().optional().openapi({ param: { name, in: "query" }, description: "日本時間の日付 YYYY-MM-DD" });

const listErrorsRoute = createRoute({
  method: "get",
  path: "/api/v1/errors",
  operationId: "listErrors",
  tags: ["system"],
  summary: "エラーログ一覧",
  description: "D1 の error_events を新しい順に返す。スタックトレースは含めず、Workers Logs で traceId から確認する。",
  "x-steps": ["指定期間の年のデータベースを新しい年から選ぶ", "`error_events` を期間、`source`、`code` で絞り込み、新しい順に取得する"],
  "x-errors": ["422 `validation_failed`: `from` が `to` より後"],
  request: {
    query: z
      .object({
        from: Day("from"),
        to: Day("to"),
        source: z.enum(ERROR_SOURCES).optional().openapi({ param: { name: "source", in: "query" } }),
        code: ErrorEventCode.optional().openapi({ param: { name: "code", in: "query" } }),
      })
      .extend(listQuery(router).shape)
      // カーソルは前のページの最後の行の ID なので、UUID の形だけを受ける
      .extend({ cursor: z.uuid().optional().openapi({ param: { name: "cursor", in: "query" }, description: "前のレスポンスの meta.next" }) })
      .strict(),
  },
  responses: { 200: listResponse(ErrorEvent), ...problems(400, 401, 403, 422, 429, 500) },
});

const getTraceRoute = createRoute({
  method: "get",
  path: "/api/v1/traces/{traceId}",
  operationId: "getTrace",
  tags: ["system"],
  summary: "traceId でリクエストを追跡する",
  description: "同じ traceId を持つエラー、監査ログ、ツール呼び出し、使用量、タスクのイベント、メッセージを時刻順に返す。15 分以内のパスキーの確認が必要。",
  "x-steps": [
    "パスキーの確認を求める",
    "今年と前年のデータベースから、`error_events`、`audit_log`、`tool_calls`、`usage`、`node_events`、`messages` を `trace_id` のインデックスで取得する",
    "時刻順に並べ、追跡を閲覧したことを監査ログに記録して返す",
  ],
  "x-errors": ["401 `step_up_required`: パスキーの確認がない", "422 `validation_failed`: traceId が 32 桁の 16 進数ではない", "404 `not_found`: 該当するレコードがない"],
  "x-step-up": true,
  middleware: [stepUpGate] as const,
  request: {
    params: z.object({ traceId: TraceId.openapi({ param: { name: "traceId", in: "path" }, description: "traceparent ヘッダーの trace-id と同じ 32 桁の 16 進数" }) }).strict(),
  },
  responses: { 200: okResponse(Trace), ...problems(401, 403, 404, 422, 429, 500) },
});

/** 年とその置き場 */
type YearDb = { year: number; db: D1Database; start: number; end: number };

/**
 * バインドした年の置き場を、新しい年から並べる。プレビューは全部の年が 1 つの置き場なので、行はその年の期間で切って重ねない
 * @param env バインディング
 * @param years 読む年の範囲
 * @param years.from 始めの年
 * @param years.to 終わりの年
 * @returns 年と置き場
 */
function yearDbs(env: Bindings, years: { from: number; to: number }): YearDb[] {
  return RECORD_BINDINGS.flatMap((name) => {
    const year = Number(name.slice("REC_".length));
    const db = env[name];
    if (!db || year < years.from || year > years.to) return [];
    return [{ year, db, start: jstDayStart(`${String(year)}-01-01`), end: jstDayStart(`${String(year + 1)}-01-01`) }];
  }).toSorted((a, b) => b.year - a.year);
}

const ErrorRow = z.object({
  id: z.string(),
  at: z.number(),
  source: z.enum(ERROR_SOURCES),
  level: z.enum(["error", "warn"]),
  code: z.string(),
  message: z.string(),
  route: z.string().nullable(),
  status: z.number().nullable(),
  staff_id: z.string().nullable(),
  node_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  fingerprint: z.string(),
});

/**
 * エラーログの行を返す形にする
 * @param row error_events の行
 * @returns ErrorEvent
 */
function toErrorEvent(row: z.infer<typeof ErrorRow>): ErrorEvent {
  return {
    id: row.id,
    at: new Date(row.at).toISOString(),
    source: row.source,
    level: row.level,
    code: row.code,
    // 書いた側が伏せ損ねた鍵と作業トークンも、返す前にもう 1 度伏せる
    message: redactText(row.message),
    route: row.route,
    status: row.status,
    staffId: row.staff_id,
    nodeId: row.node_id,
    traceId: row.trace_id,
    fingerprint: row.fingerprint,
  };
}

/** 追う 1 行。at はミリ秒で、並べた後に RFC 3339 にする */
type TraceLine = { at: number; id: string; kind: Trace["items"][number]["kind"]; summary: string };

/** 6 つの表の読み方。行の形を Zod で確かめ、誰が何をしたかの 1 行にする */
type TraceRead = { kind: TraceLine["kind"]; sql: string; line: (raw: unknown) => { id: string; at: number; summary: string } };

/**
 * 1 つの表の読み方を作る
 * @param kind 種類
 * @param sql 読む列と表
 * @param Row 行の形
 * @param summary 1 行にする
 * @returns 読み方
 */
function traceRead<T extends { id: string; at: number }>(kind: TraceLine["kind"], sql: string, Row: z.ZodType<T>, summary: (row: T) => string): TraceRead {
  return {
    kind,
    sql,
    line: (raw) => {
      const parsed = Row.parse(raw);
      // 会話とエラーの文に混じった鍵と作業トークンを、画面に出す前に伏せる
      return { id: parsed.id, at: parsed.at, summary: redactText(summary(parsed)) };
    },
  };
}

const text = z.string();
const maybe = z.string().nullable();
const row = <S extends z.ZodRawShape>(shape: S) => z.object({ id: text, at: z.number(), ...shape });

const TRACE_READS: TraceRead[] = [
  traceRead("error", "SELECT id, at, source, level, code, message FROM error_events", row({ source: text, level: text, code: text, message: text }), (r) => `${r.source} の ${r.level} ${r.code}: ${r.message}`),
  traceRead("audit", "SELECT id, at, actor, action, target FROM audit_log", row({ actor: text, action: text, target: maybe }), (r) => `${r.actor} が ${r.action}${r.target === null ? "" : ` (${r.target})`}`),
  traceRead(
    "tool_call",
    "SELECT id, at, staff_id, tool, allowed FROM tool_calls",
    row({ staff_id: text, tool: text, allowed: z.number() }),
    (r) => `${r.staff_id} が ${r.tool} を呼んだ (${r.allowed === 1 ? "通した" : "断った"})`,
  ),
  traceRead(
    "usage",
    "SELECT id, at, staff_id, model, input_tokens, output_tokens FROM usage",
    row({ staff_id: text, model: text, input_tokens: z.number(), output_tokens: z.number() }),
    (r) => `${r.staff_id} が ${r.model} を使った (入力 ${String(r.input_tokens)}、出力 ${String(r.output_tokens)})`,
  ),
  traceRead("node_event", "SELECT id, at, staff_id, kind FROM node_events", row({ staff_id: maybe, kind: text }), (r) => `${r.staff_id ?? "system"} のタスクの出来事 ${r.kind}`),
  traceRead(
    "message",
    "SELECT id, at, staff_id, sender, body FROM messages",
    row({ staff_id: text, sender: text, body: text }),
    // 会話は頭だけを出す。サロゲートの組を割らないよう、コードポイントで切る
    // 頭で切ると鍵の形が崩れて伏せ損ねるので、切る前に伏せる
    (r) => `${r.sender === "owner" ? "owner" : r.staff_id} の発言: ${Array.from(redactText(r.body)).slice(0, MESSAGE_HEAD).join("")}`,
  ),
];

/**
 * 1 つの年の置き場から、同じ traceId の行を 6 つの表から読む
 * @param year 年と置き場
 * @param traceId トレース ID
 * @returns 追う行
 */
async function traceLines(year: YearDb, traceId: string): Promise<TraceLine[]> {
  const results = await year.db.batch(TRACE_READS.map((t) => year.db.prepare(`${t.sql} WHERE trace_id = ? AND at >= ? AND at < ?`).bind(traceId, year.start, year.end)));
  return TRACE_READS.flatMap((read, i) => (results[i]?.results ?? []).map((raw) => ({ ...read.line(raw), kind: read.kind })));
}

/** エラーログと要求をたどるルート */
export const traceRoutes = router
  .openapi(listErrorsRoute, async (c) => {
    const { from, to, source, code, cursor, limit } = c.req.valid("query");
    if (from && to && from > to) throw new AppError("validation_failed", "from が to より後", { errors: [{ pointer: "#/query/from", detail: "to より前の日にする" }] });
    // 日本時間の日で受け、その日の 0 時から、to の次の日の 0 時の前までを読む
    const start = from ? jstDayStart(from) : 0;
    const end = to ? jstDayStart(to) + DAY : Number.MAX_SAFE_INTEGER;
    const now = c.var.clock.now();
    const years = yearDbs(c.env, { from: from ? jstYear(start) : 0, to: Math.min(jstYear(Math.min(end, now + DAY) - 1), jstYear(now)) });
    // ID は UUID v7 で書いた順に並び、後の年ほど大きい。新しい年から読み、limit を 1 件超えたら次のページがある
    const rows: z.infer<typeof ErrorRow>[] = [];
    for (const year of years) {
      if (rows.length > limit) break;
      // 値はどれも確かめた形で、文には ? だけを置く
      const filters: [string, unknown][] = [
        ["at >= ?", Math.max(start, year.start)],
        ["at < ?", Math.min(end, year.end)],
        ...(source ? [["source = ?", source] satisfies [string, unknown]] : []),
        ...(code ? [["code = ?", code] satisfies [string, unknown]] : []),
        ...(cursor ? [["id < ?", cursor] satisfies [string, unknown]] : []),
      ];
      const where = filters.map(([sql]) => sql);
      const args = filters.map(([, value]) => value);
      const { results } = await year.db
        .prepare(`SELECT id, at, source, level, code, message, route, status, staff_id, node_id, trace_id, fingerprint FROM error_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
        .bind(...args, limit + 1 - rows.length)
        .all();
      rows.push(...z.array(ErrorRow).parse(results));
    }
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
    return list(c, page.map(toErrorEvent), next);
  })
  .openapi(getTraceRoute, async (c) => {
    const { traceId } = c.req.valid("param");
    const thisYear = jstYear(c.var.clock.now());
    const lines = (await Promise.all(yearDbs(c.env, { from: thisYear - 1, to: thisYear }).map((year) => traceLines(year, traceId)))).flat();
    if (lines.length === 0) throw new AppError("not_found", "この traceId の記録は無い");
    // 監査ログと会話を含むので、読んだ事を残す
    await audit(c, "trace.read", traceId);
    return ok(c, { traceId, items: lines.toSorted((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).map((l) => ({ at: new Date(l.at).toISOString(), kind: l.kind, summary: l.summary, id: l.id })) });
  });
