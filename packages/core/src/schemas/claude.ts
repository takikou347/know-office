// Claude の API が返す失敗の本文の形 (サービスと拡張の 3.5)
import { z } from "zod";

/**
 * Claude の API の失敗の本文。値は増えうるので、知らない項目は通す
 * 出典: platform.claude.com/docs/en/api/errors (error の type と message は必ずある) と /docs/en/api/rate-limits (error.details.error_code)
 */
export const ClaudeErrorBody = z.looseObject({
  error: z.looseObject({
    type: z.string(),
    message: z.string(),
    details: z.looseObject({ error_code: z.string().optional() }).nullish(),
  }),
});

/** Claude の API の失敗の本文の型 */
export type ClaudeErrorBody = z.infer<typeof ClaudeErrorBody>;

/** 使用の上限の種類。organization と workspace は Console で決めた上限、monthly は月の使用の上限、billing は支払い */
export const SPEND_LIMIT_KINDS = ["organization", "workspace", "monthly", "billing"] as const;

/** 使用の上限の種類の型 */
export type SpendLimitKind = (typeof SPEND_LIMIT_KINDS)[number];
