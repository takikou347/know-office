// 画面が持つ今のデータ (社員の状態、タスクの担当と状態) の置き場。ほかの画面の操作がここを変え、オフィスは変わりから出来事を起こす
import { staff, tasks } from "../../mock.ts";
import type { OfficeSnapshot, WorkTask } from "./events.ts";

/** 画面のデータの置き場 */
export interface WorkFeed {
  /** 今の写し。変えるたびに新しい物になる */
  snapshot: () => OfficeSnapshot;
  /** タスクの状態を変える */
  setTaskState: (taskId: string, state: WorkTask["state"]) => void;
  /** タスクを足す */
  addTask: (task: WorkTask) => void;
  /** 変わりを聞く。返した関数で聞くのをやめる */
  subscribe: (listener: () => void) => () => void;
  /** オフィスが最後に見た写し。初めは置き場を作った時の写しにし、オフィスを開く前の操作も出来事にする */
  seen: OfficeSnapshot;
}

/**
 * データの置き場を作る
 * @param initial 初めの写し
 * @returns 置き場
 */
export function createWorkFeed(initial: OfficeSnapshot): WorkFeed {
  let now: OfficeSnapshot = initial;
  const listeners = new Set<() => void>();
  const commit = (next: OfficeSnapshot) => {
    now = next;
    for (const l of listeners) l();
  };
  return {
    snapshot: () => now,
    setTaskState: (taskId, state) => {
      const old = now.tasks.find((t) => t.id === taskId);
      if (!old || old.state === state) return;
      commit({ ...now, tasks: now.tasks.map((t) => (t.id === taskId ? { ...t, state } : t)) });
    },
    addTask: (task) => commit({ ...now, tasks: [...now.tasks, task] }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    seen: initial,
  };
}

/** 画面全体で 1 つの置き場。今はモックの仮のデータから始め、記録には残さない */
export const workFeed: WorkFeed = createWorkFeed({
  staff: staff.map((s) => ({ id: s.id, state: s.state })),
  tasks: tasks.map((t) => ({ id: t.id, staffId: t.staffId, title: t.title, state: t.state })),
});
