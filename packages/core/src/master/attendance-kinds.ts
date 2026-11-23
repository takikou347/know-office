// 勤怠の区分のマスタデータ。どの 1 分もこのどれか 1 つに入る (社員と勤怠の 1 章)
import { defineMaster } from "./master.ts";

/** 勤怠の区分。所定の勤務、延長、時間外の呼び出しが働いた時間に入る */
export const ATTENDANCE_KINDS = defineMaster([
  { value: "scheduled", label: "所定の勤務" },
  { value: "extension", label: "延長" },
  { value: "call", label: "時間外の呼び出し" },
  { value: "stopped", label: "止められていた時間" },
  { value: "waiting", label: "待っていた時間" },
]);
