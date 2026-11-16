// エラーログと、traceId で 1 つのリクエストを追う返す形。ルートはまだ無い (#111)
import { ErrorCode } from "./common.ts";
import { z } from "./zod.ts";

/** エラーログを書いた所 */
export const ERROR_SOURCES = ["gate", "staff_do", "recorder_do", "guard_do", "live_do", "workspace", "job"] as const;

/** エラーログの 1 行の返す形。時刻は RFC 3339 の協定世界時 */
export const ErrorEvent = z
  .object({
    id: z.uuid().meta({ description: "UUID v7" }),
    at: z.iso.datetime(),
    source: z.enum(ERROR_SOURCES),
    level: z.enum(["error", "warn"]),
    code: ErrorCode,
    message: z.string(),
    route: z.string().nullable(),
    status: z.int().nullable(),
    staffId: z.string().nullable(),
    nodeId: z.string().nullable(),
    traceId: z.string(),
    fingerprint: z.string(),
  })
  .strict()
  .meta({ id: "ErrorEvent" });

/** エラーログの 1 行の型 */
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** 同じ traceId を持つ記録を時刻の順に並べた返す形 */
export const Trace = z
  .object({
    traceId: z.string(),
    items: z.array(
      z
        .object({
          at: z.iso.datetime(),
          kind: z.enum(["error", "audit", "tool_call", "usage", "node_event", "message"]),
          summary: z.string(),
          id: z.uuid().meta({ description: "UUID v7" }),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: "Trace" });

/** 追った記録の型 */
export type Trace = z.infer<typeof Trace>;
