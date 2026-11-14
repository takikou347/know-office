// D1 の DB (今の状態と小さい追記専用テーブル) のスキーマ。テーブルは節ごとのファイルに置き、ここでまとめる。データの 2 章
export * from "./main-login.ts";
export * from "./main-tasks.ts";
export * from "./main-work.ts";

/** 書き換えと消すをトリガーで断るテーブル。データの 3.2 */
export const MAIN_APPEND_ONLY = [
  "login_attempts",
  "health_checks",
  "staff_prompts",
  "attendance",
  "work_entries",
  "day_orders",
  "staff_buckets",
  "stops",
  "stop_updates",
  "transcript_parts",
  "review_notes",
  "service_events",
  "settings",
  "service_settings",
  "owner_data_reads",
] as const;
