// タスクの状態のマスタデータ。目標の画面の 4 列、社員の画面とホームの印の名前に使う (タスクとレビューの 3.1)
import { defineMaster } from "./master.ts";

/** タスクの状態。並びは画面に出す順 */
export const TASK_STATUSES = defineMaster([
  { value: "todo", label: "未着手" },
  { value: "doing", label: "進行中" },
  { value: "review", label: "レビュー" },
  { value: "done", label: "完了" },
  { value: "stopped", label: "停止中", note: "自動停止かオーナーが止めた" },
  { value: "waiting_owner", label: "オーナー待ち", note: "オーナーの承認か答えを待つ" },
  { value: "dropped", label: "取り消し" },
]);
