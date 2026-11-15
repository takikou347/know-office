// 画面が持つ今のデータ (社員の状態、タスクの担当と状態) の変わりから、オフィスで見せる出来事を決める
import type { Staff, Task } from "../../mock.ts";

/** 仕事を渡す社員 */
export const ASSIGNER = "president";
/** レビューをする社員 */
export const REVIEWER = "reviewer";

/** 出来事を決めるのに使うタスクの項目 */
export type WorkTask = Pick<Task, "id" | "staffId" | "title" | "state">;

/** ある時の、社員の状態とタスクの写し */
export interface OfficeSnapshot {
  staff: readonly Pick<Staff, "id" | "state">[];
  tasks: readonly WorkTask[];
}

/** オフィスで見せる出来事 */
export type OfficeEvent =
  | { kind: "assign"; taskId: string; title: string; from: string; to: string }
  | { kind: "review-request"; taskId: string; title: string; from: string; to: string }
  | { kind: "approve"; taskId: string; title: string; by: string; owner: string }
  | { kind: "send-back"; taskId: string; title: string; by: string; to: string }
  | { kind: "state"; staffId: string; from: Staff["state"]; to: Staff["state"] };

/**
 * 2 つの写しの違いから出来事を決める。タスクの並びの順に、渡す、レビューを頼む、承認か差し戻しを出し、最後に社員の状態の変わりを出す
 * @param prev 前の写し
 * @param next 今の写し
 * @returns 出来事の並び
 */
export function eventsBetween(prev: OfficeSnapshot, next: OfficeSnapshot): OfficeEvent[] {
  const events: OfficeEvent[] = [];
  const before = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const old = before.get(t.id);
    const isNew = old === undefined;
    const handedOver = old !== undefined && old.staffId !== t.staffId;
    const forOthers = t.staffId !== ASSIGNER;
    // 新しいタスクと担当の替わったタスクは、社長が担当に渡す
    if ((isNew || handedOver) && forOthers) events.push({ kind: "assign", taskId: t.id, title: t.title, from: ASSIGNER, to: t.staffId });
    const wasWaiting = old?.state === "可待ち";
    const isWaiting = t.state === "可待ち";
    const byOthers = t.staffId !== REVIEWER;
    const backToWork = t.state === "今" || t.state === "次";
    const entersReview = isWaiting && old?.state !== t.state;
    if (entersReview && byOthers) events.push({ kind: "review-request", taskId: t.id, title: t.title, from: t.staffId, to: REVIEWER });
    if (wasWaiting && t.state === "済") events.push({ kind: "approve", taskId: t.id, title: t.title, by: REVIEWER, owner: t.staffId });
    if (wasWaiting && backToWork) events.push({ kind: "send-back", taskId: t.id, title: t.title, by: REVIEWER, to: t.staffId });
  }
  const states = new Map(prev.staff.map((s) => [s.id, s.state]));
  for (const s of next.staff) {
    const was = states.get(s.id);
    const changed = was !== undefined && was !== s.state;
    if (changed) events.push({ kind: "state", staffId: s.id, from: was, to: s.state });
  }
  return events;
}

const STATE_WORDS: Readonly<Record<Staff["state"], string>> = {
  working: "働き始めた",
  paused: "休憩所で待ち始めた",
  stopped: "止められた",
  off: "退勤した",
};

/**
 * 出来事を読み上げる文にする
 * @param e 出来事
 * @param roleOf 社員の id から役目の名前を返す関数
 * @returns 1 文
 */
export function describeEvent(e: OfficeEvent, roleOf: (id: string) => string): string {
  switch (e.kind) {
    case "assign":
      return `${roleOf(e.from)}が${roleOf(e.to)}に「${e.title}」を渡した`;
    case "review-request":
      return `${roleOf(e.from)}が${roleOf(e.to)}に「${e.title}」のレビューを頼んだ`;
    case "approve":
      return `${roleOf(e.by)}が「${e.title}」を承認した`;
    case "send-back":
      return `${roleOf(e.by)}が「${e.title}」を${roleOf(e.to)}に差し戻した`;
    case "state":
      return `${roleOf(e.staffId)}が${STATE_WORDS[e.to]}`;
    default:
      return e satisfies never;
  }
}

/** 読み上げる出来事の数の上限。超えた分は件数だけを読む */
export const NEWS_LIMIT = 3;

/**
 * 1 つのまとまりの出来事を、読み上げる 1 つの文にする。上限を超えた分は「ほか N 件」にする
 * @param events 出来事の並び
 * @param roleOf 社員の id から役目の名前を返す関数
 * @returns 読み上げる文
 */
export function newsOf(events: readonly OfficeEvent[], roleOf: (id: string) => string): string {
  if (events.length === 0) return "直近の出来事はまだありません";
  const said = events.slice(0, NEWS_LIMIT).map((e) => describeEvent(e, roleOf));
  const rest = events.length - said.length;
  const more = rest > 0 ? [`ほか ${rest} 件`] : [];
  return `直近の出来事: ${[...said, ...more].join("。")}`;
}
