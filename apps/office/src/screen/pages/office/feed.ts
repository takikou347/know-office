// 画面が持つ今のデータ (社員の状態、タスク) の置き場。モックの間は、タスクの一覧と詳細もオフィスもここ 1 つから読み、
// ほかの画面の操作がここを変え、オフィスは前に受け取った時からの変わりを出来事にする
// TODO(#87): 本番は出来事をサーバーで作って送り、画面は受けて見せるだけにする。初めて読み込んだ時の状態は出来事にしない
import type { NodeStatus } from "@know-office/core";
import { useSyncExternalStore } from "react";
import { type Task, staff, tasks } from "../../mock.ts";
import type { OfficeSnapshot } from "./events.ts";

/** 置き場の写し。タスクは一覧と詳細に要る項目まで持つ */
export interface WorkSnapshot extends OfficeSnapshot {
  tasks: readonly Task[];
}

/** 画面のデータの置き場 */
export interface WorkFeed {
  /** 今の写し。変えるたびに新しい物になる */
  snapshot: () => WorkSnapshot;
  /** タスクの状態を変える */
  setTaskState: (taskId: string, state: Task["state"]) => void;
  /** タスクを足す */
  addTask: (task: Task) => void;
  /** 入口から読んだタスクを、出来事にせずに知っている事にする。もう知っているタスクは変えない */
  know: (task: Task) => void;
  /** 変わりを聞く。返した関数で聞くのをやめる */
  subscribe: (listener: () => void) => () => void;
  /** オフィスが受け取る。前に受け取った時 (初めは置き場を作った時) の写しと今の写しを返し、今を受け取った事にする */
  take: () => { before: WorkSnapshot; now: WorkSnapshot };
}

/**
 * データの置き場を作る
 * @param initial 初めの写し
 * @returns 置き場
 */
export function createWorkFeed(initial: WorkSnapshot): WorkFeed {
  let now = initial;
  let taken = initial;
  const listeners = new Set<() => void>();
  const commit = (next: WorkSnapshot) => {
    now = next;
    for (const l of listeners) l();
  };
  return {
    snapshot: () => now,
    setTaskState: (taskId, state) => {
      const old = now.tasks.find((t) => t.id === taskId);
      const changes = old !== undefined && old.state !== state;
      if (changes) commit({ ...now, tasks: now.tasks.map((t) => (t.id === taskId ? { ...t, state } : t)) });
    },
    addTask: (task) => commit({ ...now, tasks: [...now.tasks, task] }),
    know: (task) => {
      if (now.tasks.some((t) => t.id === task.id)) return;
      // 初めて読んだ時の状態は出来事にしないので、受け取った写しにも同じ物を足す
      taken = { ...taken, tasks: [...taken.tasks, task] };
      commit({ ...now, tasks: [...now.tasks, task] });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    take: () => {
      const before = taken;
      taken = now;
      return { before, now };
    },
  };
}

/** 画面全体で 1 つの置き場。今はモックの仮のデータから始め、記録には残さない */
export const workFeed: WorkFeed = createWorkFeed({
  staff: staff.map((s) => ({ id: s.id, state: s.state })),
  tasks,
});

/** 入口のタスクの状態を、置き場の状態にする */
const FEED_STATES: Readonly<Record<NodeStatus, Task["state"]>> = { todo: "次", doing: "今", review: "可待ち", done: "済", stopped: "次", waiting_owner: "次", dropped: "済" };

/**
 * 入口から読んだタスクを置き場に知らせる。オフィスはここからの変わりを出来事にする
 * TODO(#87): 本番は出来事をサーバーで作って配信で送り、この橋を消す
 * @param node 入口から読んだタスク
 * @param node.id タスク ID
 * @param node.assignee 担当の社員 ID
 * @param node.title 題
 * @param node.status 状態
 */
export function knowNode(node: { id: string; assignee: string | null; title: string; status: NodeStatus }): void {
  if (node.assignee === null) return;
  workFeed.know({ id: node.id, staffId: node.assignee, title: node.title, service: "", state: FEED_STATES[node.status] });
}

/**
 * レビューの判断を置き場に写す。承認は済、差し戻しは今にし、オフィスが承認か差し戻しの出来事にする
 * TODO(#87): 本番は出来事をサーバーで作って配信で送り、この橋を消す
 * @param nodeId タスク ID
 * @param verdict 判断
 */
export function reviewDecided(nodeId: string, verdict: "approve" | "request_changes"): void {
  workFeed.setTaskState(nodeId, verdict === "approve" ? "済" : "今");
}

/**
 * 置き場のタスクを読み、変わったら描き直す
 * @returns 今のタスクの並び
 */
export function useWorkTasks(): readonly Task[] {
  const read = () => workFeed.snapshot().tasks;
  // サーバーで描く時も、同じ置き場の今のタスクを出す
  return useSyncExternalStore(workFeed.subscribe, read, read);
}
