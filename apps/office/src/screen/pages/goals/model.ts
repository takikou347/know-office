// 目標の画面に出す形を木から組み立てる。目標のカード、タスクの 4 列、期限の出し方 (タスクとレビューの 3.1)
import type { NodeStatus, NodeTree } from "@know-office/core";
import { labelOf } from "@know-office/core/master/master";
import { TASK_STATUSES } from "@know-office/core/master/task-statuses";

/** 目標のカード 1 枚。受け付けのプロジェクトも目標と同じに並べる */
export interface GoalCard {
  /** 目標か、受け付けのプロジェクト */
  goal: NodeTree;
  /** 目標の親の目的。受け付けのプロジェクトには無い */
  purpose: NodeTree | null;
  /** 取り消したタスクを除いたタスクの数 */
  tasks: number;
  /** 済んだタスクの数 */
  done: number;
}

/**
 * 下にあるタスクを、取り消した物を除いて集める
 * @param node 目標かプロジェクト
 * @returns タスクと、そのタスクを持つプロジェクト
 */
function tasksUnder(node: NodeTree): { task: NodeTree; project: NodeTree }[] {
  if (node.kind === "project") return node.children.filter((c) => c.kind === "task" && c.status !== "dropped").map((task) => ({ task, project: node }));
  return node.children.flatMap(tasksUnder);
}

/**
 * 木の根から目標のカードを作る。目的の下の目標と、親の無い受け付けのプロジェクトを並べる
 * @param roots 木の根
 * @param purposeId 絞る目的の ID。無ければすべて
 * @returns 目標のカード
 */
export function goalCards(roots: readonly NodeTree[], purposeId?: string | null): GoalCard[] {
  const pairs = roots.flatMap((root): { goal: NodeTree; purpose: NodeTree | null }[] => {
    if (root.kind === "purpose") return root.children.filter((g) => g.kind === "goal").map((goal) => ({ goal, purpose: root }));
    return root.kind === "project" || root.kind === "goal" ? [{ goal: root, purpose: null }] : [];
  });
  return pairs
    .filter((p) => purposeId === undefined || purposeId === null || p.purpose?.id === purposeId)
    .map(({ goal, purpose }) => {
      const tasks = tasksUnder(goal);
      return { goal, purpose, tasks: tasks.length, done: tasks.filter((t) => t.task.status === "done").length };
    });
}

/** タスクの列 1 つ */
export interface Column {
  /** 列の名前 */
  label: string;
  /** 列に並べるタスクと、そのタスクを持つプロジェクト */
  tasks: { task: NodeTree; project: NodeTree }[];
}

/** 列ごとに並べる状態。列の名前は先頭の状態の名前にする。止めた物とオーナーの答え待ちは、まだ進めていないので未着手に並べる */
const COLUMNS: readonly { head: NodeStatus; statuses: readonly NodeStatus[] }[] = [
  { head: "todo", statuses: ["todo", "stopped", "waiting_owner"] },
  { head: "doing", statuses: ["doing"] },
  { head: "review", statuses: ["review"] },
  { head: "done", statuses: ["done"] },
];

/**
 * 目標の下のタスクを状態の 4 列に分ける。取り消したタスクは出さない
 * @param goal 目標か、受け付けのプロジェクト
 * @param projectId 絞るプロジェクトの ID。無ければすべて
 * @returns 未着手、進行中、レビュー、完了の 4 列
 */
export function boardOf(goal: NodeTree, projectId?: string | null): Column[] {
  const tasks = tasksUnder(goal).filter((t) => projectId === undefined || projectId === null || t.project.id === projectId);
  return COLUMNS.map((c) => ({ label: labelOf(TASK_STATUSES, c.head), tasks: tasks.filter((t) => c.statuses.includes(t.task.status)) }));
}

/** 期限の出し方 */
export interface Due {
  /** 出す文 */
  text: string;
  /** 色。過ぎたら error、7 日以内は warn */
  tone: "neutral" | "warn" | "error";
}

const DAY_MS = 86_400_000;

/**
 * 期限の日を、今日との近さで出す文と色にする。済んだ物は日付だけを出す
 * @param dueDay 期限の日 (YYYY-MM-DD)
 * @param today 今日 (YYYY-MM-DD)
 * @param done 済んだタスクか、進み具合が 100% の目標か
 * @returns 出し方。期限が無ければ null
 */
export function dueOf(dueDay: string | null, today: string, done = false): Due | null {
  if (dueDay === null) return null;
  const [, month = "", day = ""] = dueDay.split("-");
  const text = `期限 ${String(Number(month))}/${String(Number(day))}`;
  if (done) return { text, tone: "neutral" };
  const left = (Date.parse(dueDay) - Date.parse(today)) / DAY_MS;
  if (left < 0) return { text: `${text} (期限切れ)`, tone: "error" };
  return { text, tone: left <= 7 ? "warn" : "neutral" };
}

/**
 * 日付のピッカーが返す日を、期限の日の文字 (YYYY-MM-DD) にする。ピッカーは画面の時刻の日を返す
 * @param date ピッカーの日
 * @returns YYYY-MM-DD
 */
export function dayOf(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 期限の日の文字を、日付のピッカーに渡す日にする
 * @param day YYYY-MM-DD か無し
 * @returns 画面の時刻のその日の 0 時。無ければ null
 */
export function dateOf(day: string | null): Date | null {
  if (day === null) return null;
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}
