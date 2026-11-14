// どのルートにも共通の返す形。meta の id は v1.yaml の components/schemas の名前と同じ
import { z } from "zod";
import { ERROR_CODES } from "../errors.ts";

export const Meta = z.object({ traceId: z.string() }).strict().meta({ id: "Meta" });

export const ListMeta = z.object({ traceId: z.string(), next: z.string().nullable() }).strict().meta({ id: "ListMeta" });

export const ErrorCode = z.enum(ERROR_CODES).meta({ id: "ErrorCode" });

/** 失敗の種類。`ERROR_CODES` の 1 つ */
export type ErrorCode = z.infer<typeof ErrorCode>;

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

export type Problem = z.infer<typeof Problem>;

export const Part = z.enum(["gate", "screen", "workspace"]);

export const Health = z.object({ ok: z.boolean(), part: Part }).strict().meta({ id: "Health" });

export type Health = z.infer<typeof Health>;
