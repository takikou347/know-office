// Cloudflare の GraphQL Analytics API (workersInvocationsAdaptive) の返事の形 (サービスと拡張の 3.2)
import { z } from "./zod.ts";

/** スクリプトごとの Workers の呼び出しの数。errors は、例外を投げた、資源を超えた、内部エラーの呼び出し (アプリが返した 5xx は数えない) */
const InvocationRow = z
  .object({ sum: z.object({ requests: z.number().int().min(0), errors: z.number().int().min(0) }).loose(), dimensions: z.object({ scriptName: z.string() }).loose() })
  .loose();

/**
 * GraphQL Analytics API の返事。data か errors のどちらかを持つ
 * 出典 (項目と形): https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
 * errors の意味: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/ の「Requests that returned a Script Threw Exception, Exceeded Resources, or Internal Error invocation status」。
 * 呼び出しの状態は HTTP のステータスと別で、アプリが返した 5xx は success の呼び出しに入る
 */
export const WorkersInvocationsResponse = z
  .object({
    data: z
      .object({ viewer: z.object({ accounts: z.array(z.object({ workersInvocationsAdaptive: z.array(InvocationRow) }).loose()) }).loose() })
      .loose()
      .nullable(),
    errors: z.array(z.object({ message: z.string() }).loose()).nullable().optional(),
  })
  .loose();

/** GraphQL Analytics API の返事の型 */
export type WorkersInvocationsResponse = z.infer<typeof WorkersInvocationsResponse>;

/** 画面が「訪問か」を知らせるヘッダーの名前。画面が開いて最初の API の呼び出しだけに付ける */
export const VISIT_HEADER = "x-visit";

/**
 * 訪問の知らせ。画面が document.referrer から決めた真偽の 1 値だけを受け、referrer の文字列は受けない。
 * 偽っても know-office の訪問の数が増えるだけで、ほかの判断に効かない
 */
export const VisitHeader = z.literal("1").openapi({
  param: { name: "X-Visit", in: "header", required: false },
  description: "画面が開いて最初の API の呼び出しで、直に開いたかほかのサイトから来た時だけ `1` を付ける。ログインを通った呼び出しの時だけ、Workers Analytics Engine に訪問として 1 点書く (サービスと拡張の 3.2)",
});

/** SUM の結果。小数になりうる。64 ビットの数は文字列で返る事があるので、数の文字列も受ける。負と数でない物は断る */
const Sum = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]).pipe(z.number().finite().min(0));

/**
 * Workers Analytics Engine の SQL API が FORMAT JSON で返す、スクリプトごとの訪問の数
 * 出典 (形 {meta, data, rows}): https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/
 */
export const AnalyticsEngineVisits = z
  .object({ data: z.array(z.object({ script: z.string(), visits: Sum }).loose()) })
  .loose();

/** Workers Analytics Engine の SQL API の返事の型 */
export type AnalyticsEngineVisits = z.infer<typeof AnalyticsEngineVisits>;

/** SHOW TABLES の返事。列の名前は文書に無いので、行の文字列の値だけを見る */
export const AnalyticsEngineTables = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).loose();
