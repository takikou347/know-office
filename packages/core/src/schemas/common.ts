// どのルートにも共通の返す形。meta の id は v1.yaml の components/schemas の名前と同じ
import { z } from "./zod.ts";
import { ERROR_CODES } from "../errors.ts";

/** 成功の返事の meta。どの返事も traceId を持つ */
export const Meta = z.object({ traceId: z.string() }).strict().meta({ id: "Meta" });

/** 一覧の返事の meta。next は次のページのカーソルで、無ければ null */
export const ListMeta = z.object({ traceId: z.string(), next: z.string().nullable() }).strict().meta({ id: "ListMeta" });

/** 失敗の種類の Zod スキーマ */
export const ErrorCode = z.enum(ERROR_CODES).meta({ id: "ErrorCode" });

/** 失敗の種類。`ERROR_CODES` の 1 つ */
export type ErrorCode = z.infer<typeof ErrorCode>;

/** 失敗の返事 (RFC 9457 の problem+json)。errors は 422 の時だけ持つ */
export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ErrorCode,
    traceId: z.string(),
    errors: z.array(z.object({ pointer: z.string(), detail: z.string() }).strict()).optional(),
  })
  .strict()
  .meta({ id: "Problem" });

/** 失敗の返事の型 */
export type Problem = z.infer<typeof Problem>;

/** 稼働確認に答える部分 */
export const Part = z.enum(["gate", "screen", "workspace"]);

/** 稼働確認の返事 */
export const Health = z.object({ ok: z.boolean(), part: Part }).strict().meta({ id: "Health" });

/** 稼働確認の返事の型 */
export type Health = z.infer<typeof Health>;
