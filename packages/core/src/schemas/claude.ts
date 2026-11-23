// Claude の API が返す失敗の本文の形と、Claude の API の月の予算の設定 (サービスと拡張の 3.5、社員が考えるの 3.10)
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

/** Claude の API の月の予算。設定 `claude.budget` の値。額はドル (社員が考えるの 3.10) */
export const ClaudeBudget = z
  .object({
    /** 月の予算。Console の上限より下に置き、届く前に社員の呼び出しを止める */
    monthlyUsd: z.number().positive().max(10_000),
    /** 1 つのタスクの費用の上限。超えたら自動停止のシグナル task_cost でタスクを止める */
    taskMaxUsd: z.number().positive().max(1_000),
  })
  .strict();

/** Claude の API の月の予算の型 */
export type ClaudeBudget = z.infer<typeof ClaudeBudget>;

/** 月の予算の初期値。Console の上限 100 ドルに、走っている呼び出しの分の余りを残す */
export const DEFAULT_CLAUDE_BUDGET: ClaudeBudget = { monthlyUsd: 90, taskMaxUsd: 1 };
