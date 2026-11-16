// 見つけて直す仕組みの形。原因ごとの Issue と、レビュー担当がバッチ処理で返す調べの答え (サービスと拡張の 3.7、データの 2 章)
import { z } from "./zod.ts";

/** 見つけた物の種類。エラーの原因、遅い所、無駄な費用 */
export const FindingKind = z.enum(["error", "slow", "cost"]);

/** 見つけた物の状態。開いている、直した、効いた、効かずに戻す */
export const FindingStatus = z.enum(["open", "fixed", "verified", "reverted"]);

/** 見つけた物の状態の型 */
export type FindingStatus = z.infer<typeof FindingStatus>;

/** 原因の指紋。error_events の fingerprint と同じ SHA-256 の 16 進数 */
export const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

/** 原因ごとの Issue */
export const Finding = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    repo: z.string().nullable().openapi({ description: "Issue を置くリポジトリ。決まっていない間は null" }),
    issueNumber: z.number().int().nullable().openapi({ description: "Issue の番号。作れていない間は null" }),
    kind: FindingKind,
    count: z.number().int(),
    firstAt: z.iso.datetime(),
    lastAt: z.iso.datetime(),
    status: FindingStatus,
  })
  .strict()
  .meta({ id: "Finding" });

/** 原因ごとの Issue の型 */
export type Finding = z.infer<typeof Finding>;

/** 直しに要る、オーナーに上げる事。費用が増える、外との新しい連携 */
export const FindingNeeds = z.enum(["cost_increase", "external_integration"]);

/** レビュー担当が原因ごとに返す調べの答え */
export const FindingAnswer = z
  .object({
    title: z.string().min(1).max(200),
    steps: z.array(z.string().min(1).max(500)).min(1).max(20),
    needs: FindingNeeds.nullable(),
    reason: z.string().max(2000),
  })
  .strict();

/** 調べの答えの型 */
export type FindingAnswer = z.infer<typeof FindingAnswer>;

/** 効き目。直す前の 7 日と直した後の 7 日のエラーの回数 */
export const FindingEffect = z.object({ before: z.number().int(), after: z.number().int() }).strict();

/** 効き目の型 */
export type FindingEffect = z.infer<typeof FindingEffect>;
