// Cloudflare の GraphQL Analytics API (workersInvocationsAdaptive) の返事の形 (サービスと拡張の 3.2)
import { z } from "./zod.ts";

/** 1 つの区切りの Workers の呼び出しの数。1 行が 1 つの dimensions の合計 */
const InvocationRow = z.object({ sum: z.object({ requests: z.number().int().min(0), errors: z.number().int().min(0) }).loose() }).loose();

/**
 * GraphQL Analytics API の返事。data か errors のどちらかを持つ
 * 出典: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
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
