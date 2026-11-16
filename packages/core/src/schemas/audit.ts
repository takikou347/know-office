// 監査ログに頼む 1 件の形。記録 DO が受ける前に確かめる (データの 2 章)
import { z } from "./zod.ts";

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

/** 監査ログの 1 行の返す形。時刻は RFC 3339 の協定世界時 */
export const AuditRow = z
  .object({
    id: z.uuid().meta({ description: "UUID v7" }),
    at: z.iso.datetime(),
    actor: z.string(),
    action: z.string(),
    target: z.string().nullable(),
    scope: z.string().meta({ description: "`office` またはサービスの ID" }),
    detail: z.unknown().meta({ description: "操作ごとの中身。無ければ null" }),
    prevHash: z.string(),
    hash: z.string(),
    traceId: z.string().nullable(),
  })
  .strict()
  .meta({ id: "AuditRow" });

/** 監査ログの 1 行の型 */
export type AuditRow = z.infer<typeof AuditRow>;

/** ハッシュチェーンを確かめる年。記録は 2026 年から */
export const VerifyAuditInput = z.object({ year: z.int().min(2026) }).strict().meta({ id: "VerifyAuditInput" });

/** ハッシュチェーンを確かめる年の型 */
export type VerifyAuditInput = z.infer<typeof VerifyAuditInput>;

/** ハッシュチェーンを確かめた結果。brokenAt は最初に合わなかった行の ID */
export const AuditVerification = z
  .object({ ok: z.boolean(), brokenAt: z.string().nullable().meta({ description: "最初にハッシュが一致しなかった行の ID" }) })
  .strict()
  .meta({ id: "AuditVerification" });

/** ハッシュチェーンを確かめた結果の型 */
export type AuditVerification = z.infer<typeof AuditVerification>;
