// タスクの状態の印と言葉、タスクの詳細への道。社員と仕事とダッシュボードで同じ物を使う
import type { NodeStatus } from "@know-office/core";
import { labelOf } from "@know-office/core/master/master";
import { TASK_STATUSES } from "@know-office/core/master/task-statuses";
import type { StatusKind } from "knowidea-ui";

/** タスクの状態ごとの印の種類。名前はマスタデータの TASK_STATUSES から引く */
const STATUS_KINDS: Readonly<Record<NodeStatus, StatusKind>> = {
  todo: "neutral",
  doing: "working",
  review: "pending",
  done: "success",
  stopped: "stopped",
  waiting_owner: "pending",
  dropped: "neutral",
};

/** タスクの状態ごとの印の種類と名前 */
export const NODE_STATUSES: Readonly<Record<NodeStatus, { kind: StatusKind; label: string }>> = {
  todo: { kind: STATUS_KINDS.todo, label: labelOf(TASK_STATUSES, "todo") },
  doing: { kind: STATUS_KINDS.doing, label: labelOf(TASK_STATUSES, "doing") },
  review: { kind: STATUS_KINDS.review, label: labelOf(TASK_STATUSES, "review") },
  done: { kind: STATUS_KINDS.done, label: labelOf(TASK_STATUSES, "done") },
  stopped: { kind: STATUS_KINDS.stopped, label: labelOf(TASK_STATUSES, "stopped") },
  waiting_owner: { kind: STATUS_KINDS.waiting_owner, label: labelOf(TASK_STATUSES, "waiting_owner") },
  dropped: { kind: STATUS_KINDS.dropped, label: labelOf(TASK_STATUSES, "dropped") },
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
