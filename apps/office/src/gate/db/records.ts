// D1 の REC_<年> (その年の多い記録) のスキーマ。どの行も trace_id を持ち、索引を張る。データの 2 章
import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { flag, id, json, time } from "./columns.ts";

const traceId = () => text("trace_id");

/** 監査ログ。記録 DO だけが書き、前の行のハッシュでつなぐ */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    at: time("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    scope: text("scope").notNull(),
    detail: json("detail"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    traceId: traceId(),
  },
  (t) => [index("audit_log_trace").on(t.traceId), index("audit_log_at").on(t.at)],
);

/** エラーログ */
export const errorEvents = sqliteTable(
  "error_events",
  {
    id: id(),
    at: time("at").notNull(),
    source: text("source", { enum: ["gate", "staff_do", "recorder_do", "guard_do", "live_do", "workspace", "job"] }).notNull(),
    level: text("level", { enum: ["error", "warn"] }).notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    route: text("route"),
    status: integer("status"),
    staffId: text("staff_id"),
    nodeId: text("node_id"),
    fingerprint: text("fingerprint").notNull(),
    detail: json("detail"),
    traceId: traceId(),
  },
  (t) => [index("error_events_trace").on(t.traceId), index("error_events_fingerprint_at").on(t.fingerprint, t.at)],
);

/** ツールの呼び出し */
export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: id(),
    at: time("at").notNull(),
    staffId: text("staff_id").notNull(),
    nodeId: text("node_id"),
    scope: text("scope").notNull(),
    tool: text("tool").notNull(),
    opKind: text("op_kind").notNull(),
    target: text("target"),
    allowed: flag("allowed").notNull(),
    reason: text("reason"),
    ms: integer("ms"),
    traceId: traceId(),
  },
  (t) => [index("tool_calls_trace").on(t.traceId)],
);

/** Claude の使った量 */
export const usage = sqliteTable(
  "usage",
  {
    id: id(),
    at: time("at").notNull(),
    staffId: text("staff_id").notNull(),
    nodeId: text("node_id"),
    scope: text("scope").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costMicroUsd: integer("cost_micro_usd").notNull(),
    requestId: text("request_id"),
    waitedMs: integer("waited_ms"),
    traceId: traceId(),
  },
  (t) => [index("usage_trace").on(t.traceId), index("usage_at").on(t.at)],
);

/** タスクの出来事 */
export const nodeEvents = sqliteTable(
  "node_events",
  {
    id: id(),
    at: time("at").notNull(),
    nodeId: text("node_id").notNull(),
    staffId: text("staff_id"),
    kind: text("kind").notNull(),
    detail: json("detail"),
    traceId: traceId(),
  },
  (t) => [index("node_events_trace").on(t.traceId), index("node_events_node").on(t.nodeId)],
);

/** 会話 */
export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    at: time("at").notNull(),
    staffId: text("staff_id").notNull(),
    nodeId: text("node_id"),
    sender: text("sender", { enum: ["owner", "staff"] }).notNull(),
    body: text("body").notNull(),
    bodyKey: text("body_key"),
    traceId: traceId(),
  },
  (t) => [index("messages_trace").on(t.traceId), index("messages_staff_at").on(t.staffId, t.at)],
);

/** サービスの様子 */
export const serviceMetrics = sqliteTable(
  "service_metrics",
  {
    id: id(),
    serviceId: text("service_id").notNull(),
    at: time("at").notNull(),
    requests: integer("requests").notNull(),
    errors: integer("errors").notNull(),
    users: integer("users"),
    reads: integer("reads"),
    traceId: traceId(),
  },
  (t) => [index("service_metrics_trace").on(t.traceId)],
);

/** REC_<年> の全テーブルは追記専用。データの 3.2 */
export const RECORD_TABLES = ["audit_log", "error_events", "tool_calls", "usage", "node_events", "messages", "service_metrics"] as const;
