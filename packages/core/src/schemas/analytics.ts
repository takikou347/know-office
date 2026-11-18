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
