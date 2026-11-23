// 記録の画面のタブのマスタデータ。並びの順が画面のタブの順になる
import { defineMaster } from "./master.ts";

/** 記録の画面のタブ */
export const RECORD_TABS = defineMaster([
  { value: "attendance", label: "勤怠" },
  { value: "tasks", label: "タスク" },
  { value: "cost", label: "費用" },
  { value: "tokens", label: "トークン" },
  { value: "errors", label: "エラー" },
]);

/** 記録の画面のタブの値 */
export type RecordTab = (typeof RECORD_TABS)[number]["value"];
