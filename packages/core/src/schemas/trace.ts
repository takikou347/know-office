// エラーログと、traceId で 1 つのリクエストを追う返す形 (ログインと記録の 3.8)
import { z } from "./zod.ts";

/** エラーログを書いた所 */
export const ERROR_SOURCES = ["gate", "staff_do", "recorder_do", "guard_do", "live_do", "workspace", "job"] as const;

/** エラーログの code の形。ゲートウェイの ErrorCode のほか、定期ジョブとワークスペースの code (`storage_check_failed`、`sdk_failed` など) も入る */
export const ErrorEventCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** traceparent の trace-id と同じ 32 桁の 16 進数 */
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/);

/** エラーログの 1 行の返す形。時刻は RFC 3339 の協定世界時 */
export const ErrorEvent = z
  .object({
    id: z.uuid().meta({ description: "UUID v7" }),
    at: z.iso.datetime(),
    source: z.enum(ERROR_SOURCES),
    level: z.enum(["error", "warn"]),
    code: ErrorEventCode,
    message: z.string(),
    route: z.string().nullable(),
    status: z.int().nullable(),
    staffId: z.string().nullable(),
    nodeId: z.string().nullable(),
    traceId: z.string().nullable(),
    fingerprint: z.string(),
  })
  .strict()
  .meta({ id: "ErrorEvent" });

/** エラーログの 1 行の型 */
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** 同じ traceId を持つ記録を時刻の順に並べた返す形 */
export const Trace = z
  .object({
    traceId: TraceId,
    items: z.array(
      z
        .object({
          at: z.iso.datetime(),
          kind: z.enum(["error", "audit", "tool_call", "usage", "node_event", "message"]),
          summary: z.string().meta({ description: "誰が何をしたかの 1 行。会話は頭の 80 字まで" }),
          id: z.uuid().meta({ description: "UUID v7" }),
        })
        .strict(),
    ),
  })
  .strict()
  .meta({ id: "Trace" });

/** 追った記録の型 */
export type Trace = z.infer<typeof Trace>;
