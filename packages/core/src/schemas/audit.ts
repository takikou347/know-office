// 監査ログに頼む 1 件の形。記録 DO が受ける前に確かめる (データの 2.1)
import { z } from "zod";

/** 監査ログに頼む 1 件。actor は owner、社員 ID、system のどれか */
export const AuditInput = z
  .object({
    at: z.number().int().nonnegative(),
    actor: z.string().min(1),
    action: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
    target: z.string().nullable().optional(),
    scope: z.string().min(1),
    detail: z.unknown().optional(),
    traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  })
  .strict();

/** 監査ログに頼む 1 件の型 */
export type AuditInput = z.infer<typeof AuditInput>;
