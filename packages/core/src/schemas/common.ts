// どのルートにも共通の返す形。meta の id が API の文書 (v1.yaml) の components/schemas の名前になる
import { z } from "./zod.ts";
import { ERROR_CODES } from "../errors.ts";

/** 成功の返事の meta。どの返事も traceId を持つ */
export const Meta = z.object({ traceId: z.string().meta({ description: "リクエストごとのトレース ID。ログの trace_id と同じ値" }) }).strict().meta({ id: "Meta" });

/** 一覧の返事の meta。next は次のページのカーソルで、無ければ null */
export const ListMeta = z.object({ traceId: z.string(), next: z.string().nullable().meta({ description: "次のページのカーソル。最後のページでは null" }) }).strict().meta({ id: "ListMeta" });

/** 失敗の種類の Zod スキーマ */
export const ErrorCode = z.enum(ERROR_CODES).meta({ id: "ErrorCode" });

/** 失敗の種類。`ERROR_CODES` の 1 つ */
export type ErrorCode = z.infer<typeof ErrorCode>;

/** 失敗の返事 (RFC 9457 の problem+json)。errors は 422 の時だけ持つ */
export const Problem = z
  .object({
    type: z.string().meta({ description: "urn:know-office:problem:<code>" }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional().meta({ description: "リクエストのパス" }),
    code: ErrorCode,
    traceId: z.string(),
    errors: z.array(z.object({ pointer: z.string().meta({ description: "JSON Pointer。クエリパラメーターは #/query/<名前>" }), detail: z.string() }).strict()).optional(),
  })
  .strict()
  .meta({ id: "Problem", description: "RFC 9457 の Problem Details" });

/** 失敗の返事の型 */
export type Problem = z.infer<typeof Problem>;

/** 稼働確認に答える部分 */
export const Part = z.enum(["gate", "screen", "workspace"]);

/** 稼働確認の返事 */
export const Health = z
  .object({
    ok: z.boolean(),
    part: Part,
    /** ゲートウェイの足りない設定と形の違う設定の名前。値は返さない */
    missing: z.array(z.string().max(64)).max(32).optional(),
  })
  .strict()
  .meta({ id: "Health" });

/** 稼働確認の返事の型 */
export type Health = z.infer<typeof Health>;
