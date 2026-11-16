// まだ作っていないルートの形。API の文書にだけ載せ、ハンドラーは無い。作る時はルートのまとまりへ移し、ここから消す。デプロイの前に空にする
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, ErrorEvent, Trace } from "@know-office/core";
import { createRouter } from "../app.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";

const router = createRouter();
const Day = (name: string) => z.iso.date().optional().openapi({ param: { name, in: "query" }, description: "日本時間の日付 YYYY-MM-DD" });

const listErrorsRoute = createRoute({
  method: "get",
  path: "/api/v1/errors",
  operationId: "listErrors",
  tags: ["system"],
  summary: "エラーログ一覧",
  description: "D1 の error_events を新しい順に返す。スタックトレースは含めず、Workers Logs で traceId から確認する。",
  "x-steps": ["指定期間に対応するデータベースを選ぶ", "`error_events` を `source` と `code` で絞り込み、新しい順に取得する"],
  request: {
    query: z
      .object({
        from: Day("from"),
        to: Day("to"),
        source: z.string().optional().openapi({ param: { name: "source", in: "query" } }),
        code: ErrorCode.optional(),
      })
      .extend(listQuery(router).shape)
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
    "時刻順に並べて返す",
  ],
  "x-errors": ["422 `validation_failed`: traceId が 32 桁の 16 進数ではない", "404 `not_found`: 該当するレコードがない"],
  "x-step-up": true,
  request: {
    params: z
      .object({
        traceId: z
          .string()
          .regex(/^[0-9a-f]{32}$/)
          .openapi({ param: { name: "traceId", in: "path" }, description: "traceparent ヘッダーの trace-id と同じ 32 桁の 16 進数" }),
      })
      .strict(),
  },
  responses: { 200: okResponse(Trace), ...problems(401, 403, 404, 422, 429, 500) },
});

const openReviewLspRoute = createRoute({
  method: "get",
  path: "/api/v1/reviews/{nodeId}/lsp",
  operationId: "openReviewLsp",
  tags: ["reviews"],
  summary: "コード補完と定義へのジャンプ",
  "x-steps": ["`Origin` を検証する", "ワークスペースを起動し、101 を返して TypeScript の言語サーバーに接続する"],
  "x-errors": ["403 `origin_mismatch`: Origin が異なる", "503 `unavailable`: ワークスペースが起動しない"],
  request: { params: z.object({ nodeId: z.uuid().openapi({ param: { name: "nodeId", in: "path" }, description: "UUID v7" }) }).strict() },
  responses: { 101: { description: "WebSocket に切り替えた。ワークスペースを起動する" }, ...problems(401, 403, 404, 429, 500, 503) },
});

/** まだ作っていないルートと、受け持つ Issue */
export const PLANNED_ROUTES = [
  { route: listErrorsRoute, issue: "#111" },
  { route: getTraceRoute, issue: "#111" },
  { route: openReviewLspRoute, issue: "#110" },
];
