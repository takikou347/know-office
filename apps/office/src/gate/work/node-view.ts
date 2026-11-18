// 木の 1 件の行を、API で返す形にする (タスクとレビューの 3.1)
import type { Node } from "@know-office/core";
import type { nodes } from "../db/main.ts";

/**
 * 時刻 (協定世界時のミリ秒) を RFC 3339 の文字にする
 * @param at 時刻
 * @returns RFC 3339 の文字
 */
export const iso = (at: number) => new Date(at).toISOString();

/**
 * 行を返す形にする
 * @param row nodes の行
 * @param progress 進み具合
 * @returns 木の 1 件
 */
export function toNode(row: typeof nodes.$inferSelect, progress: number): Node {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parentId,
    scope: row.scope,
    title: row.title,
    body: row.body ?? "",
    taskKind: row.taskKind,
    assignee: row.assignee,
    branch: row.branch,
    status: row.status,
    priority: row.priority,
    progress,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
