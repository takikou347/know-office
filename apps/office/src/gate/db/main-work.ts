// D1 の DB のうち、社員と勤怠、自動停止、社員が考えるのテーブル。データの 2.2 から 2.4
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { flag, id, json, time } from "./columns.ts";

// 2.2 社員と勤怠

/** 社員 */
export const staff = sqliteTable("staff", {
  id: id(),
  role: text("role").notNull(),
  bossId: text("boss_id"),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  createdAt: time("created_at").notNull(),
});

/** 役目の説明文のバージョン。追記専用 */
export const staffPrompts = sqliteTable("staff_prompts", {
  id: id(),
  staffId: text("staff_id").notNull(),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  by: text("by").notNull(),
  createdAt: time("created_at").notNull(),
});

/** 勤怠。区分が閉じた時に 1 行。追記専用 */
export const attendance = sqliteTable(
  "attendance",
  {
    id: id(),
    staffId: text("staff_id").notNull(),
    day: text("day").notNull(),
    kind: text("kind", { enum: ["scheduled", "extension", "call", "stopped", "waiting"] }).notNull(),
    startedAt: time("started_at").notNull(),
    endedAt: time("ended_at").notNull(),
    reason: text("reason", { enum: ["schedule", "checkpoint_wait", "owner_instruction", "guard_stop", "rate_limit", "workspace_down"] }),
    corrects: text("corrects"),
    note: text("note"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [index("attendance_staff_day").on(t.staffId, t.day)],
);

/** した仕事。タスクを離れた時に 1 行。追記専用 */
export const workEntries = sqliteTable(
  "work_entries",
  {
    id: id(),
    staffId: text("staff_id").notNull(),
    day: text("day").notNull(),
    nodeId: text("node_id").notNull(),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    startedAt: time("started_at").notNull(),
    endedAt: time("ended_at").notNull(),
    activeMs: integer("active_ms").notNull(),
    result: text("result", { enum: ["done", "handed_back", "stopped", "continued"] }).notNull(),
    corrects: text("corrects"),
  },
  (t) => [index("work_entries_staff_day").on(t.staffId, t.day)],
);

/** その日だけの指示。取り消しは cancels を持つ行を足す。追記専用 */
export const dayOrders = sqliteTable("day_orders", {
  id: id(),
  staffId: text("staff_id").notNull(),
  day: text("day").notNull(),
  kind: text("kind").notNull(),
  until: time("until"),
  source: text("source", { enum: ["button", "chat"] }).notNull(),
  cancels: text("cancels"),
  createdAt: time("created_at").notNull(),
});

/** 日ごとの集計。attendance から作り直せる */
export const dailyTotals = sqliteTable(
  "daily_totals",
  {
    staffId: text("staff_id").notNull(),
    day: text("day").notNull(),
    clockIn: time("clock_in"),
    clockOut: time("clock_out"),
    workedMs: integer("worked_ms").notNull(),
    extensionMs: integer("extension_ms").notNull(),
    callMs: integer("call_ms").notNull(),
    stoppedMs: integer("stopped_ms").notNull(),
    waitingMs: integer("waiting_ms").notNull(),
    reasons: json("reasons"),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.day] })],
);

/** 5 分ごとの使った量。追記専用 */
export const staffBuckets = sqliteTable("staff_buckets", {
  id: id(),
  staffId: text("staff_id").notNull(),
  bucketAt: time("bucket_at").notNull(),
  tokens: integer("tokens").notNull(),
  toolCalls: integer("tool_calls").notNull(),
  onDuty: flag("on_duty").notNull(),
});

// 2.3 自動停止

/** 止めた事と止める手前。追記専用 */
export const stops = sqliteTable("stops", {
  id: id(),
  at: time("at").notNull(),
  kind: text("kind", { enum: ["stop", "near"] }).notNull(),
  scope: text("scope").notNull(),
  target: text("target").notNull(),
  signal: text("signal").notNull(),
  measured: integer("measured").notNull(),
  threshold: integer("threshold").notNull(),
  rulesVersion: integer("rules_version").notNull(),
  recentOpsKey: text("recent_ops_key"),
  nodeProgress: json("node_progress"),
  externalSources: json("external_sources"),
  model: text("model"),
  by: text("by", { enum: ["system", "owner"] }).notNull(),
});

/** 再開、判定、取った対策。追記専用 */
export const stopUpdates = sqliteTable("stop_updates", {
  id: id(),
  stopId: text("stop_id").notNull(),
  at: time("at").notNull(),
  kind: text("kind", { enum: ["resumed", "verdict", "measure"] }).notNull(),
  by: text("by", { enum: ["system", "reviewer", "owner"] }).notNull(),
  verdict: text("verdict"),
  reason: text("reason"),
  detail: json("detail"),
});

/** 蒸留の案 */
export const lessons = sqliteTable("lessons", {
  id: id(),
  createdAt: time("created_at").notNull(),
  kind: text("kind", { enum: ["prompt_rule", "threshold", "rule_tool"] }).notNull(),
  cause: text("cause").notNull(),
  proposal: text("proposal").notNull(),
  stopIds: json("stop_ids"),
  status: text("status").notNull(),
  appliedAt: time("applied_at"),
});

// 2.4 社員が考える

/** 会話の記録の部分。中身は R2 に暗号で置く。追記専用 */
export const transcriptParts = sqliteTable("transcript_parts", {
  id: id(),
  staffId: text("staff_id").notNull(),
  nodeId: text("node_id").notNull(),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  key: text("key").notNull(),
  bytes: integer("bytes").notNull(),
  createdAt: time("created_at").notNull(),
});
