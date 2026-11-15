// 仮のデータのタスクの見せ方。状態の印、担当の役の名前、レビューへの道
import type { StatusKind } from "knowidea-ui";
import { type Task, staff } from "../mock.ts";

/** タスクの状態ごとの印 */
export const TASK_KIND: Record<Task["state"], StatusKind> = { 今: "working", 可待ち: "pending", 次: "neutral", 済: "success" };

/**
 * 社員 ID から役の名前を返す
 * @param id 社員 ID
 * @returns 役の名前。知らない ID はそのまま
 */
export function roleOf(id: string): string {
  return staff.find((s) => s.id === id)?.role ?? id;
}

/**
 * タスクのレビューへの道
 * @param t タスク
 * @returns 道
 */
export function reviewHref(t: Task): string {
  return `/staff/${t.staffId}/tasks/${t.id}`;
}
