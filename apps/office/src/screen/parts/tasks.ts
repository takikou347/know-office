// タスクの状態の印と言葉、タスクの詳細への道。社員と仕事とダッシュボードで同じ物を使う
import type { NodeStatus } from "@know-office/core";
import type { StatusKind } from "knowidea-ui";

/** タスクの状態ごとの印の種類と言葉 */
export const NODE_STATUSES: Readonly<Record<NodeStatus, { kind: StatusKind; label: string }>> = {
  todo: { kind: "neutral", label: "次" },
  doing: { kind: "working", label: "今" },
  review: { kind: "pending", label: "レビュー待ち" },
  done: { kind: "success", label: "済" },
  stopped: { kind: "stopped", label: "止めた" },
  waiting_owner: { kind: "pending", label: "オーナー待ち" },
  dropped: { kind: "neutral", label: "やめた" },
};

/**
 * タスクの詳細への道。社員 ID とタスク ID だけから組む
 * @param staffId 担当の社員 ID
 * @param nodeId タスク ID
 * @returns 道
 */
export function taskHref(staffId: string, nodeId: string): string {
  return `/staff/${encodeURIComponent(staffId)}/tasks/${encodeURIComponent(nodeId)}`;
}
