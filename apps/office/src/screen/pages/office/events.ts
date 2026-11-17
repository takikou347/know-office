// 配信で届いた仕事の出来事と社員の状態の印から、オフィスで見せる出来事を決め、読み上げる文にする
import type { OfficeWork, StaffState } from "@know-office/core";
import type { RoomState } from "./layout.ts";

/** ある時の社員の状態の写し */
export interface OfficeSnapshot {
  staff: readonly { id: string; state: StaffState }[];
}

/** オフィスで見せる出来事。社員でない側 (オーナー) は owner で、部屋には居ない */
export type OfficeEvent =
  | { kind: "assign"; taskId: string; title: string; from: string; to: string }
  | { kind: "review-request"; taskId: string; title: string; from: string; to: string }
  | { kind: "approve"; taskId: string; title: string; by: string; owner: string }
  | { kind: "send-back"; taskId: string; title: string; by: string; to: string }
  | { kind: "state"; staffId: string; from: RoomState; to: RoomState };

/**
 * 配信で届いた仕事の出来事を、オフィスで見せる出来事にする
 * @param work 仕事の出来事
 * @returns オフィスの出来事
 */
export function officeEventOf(work: OfficeWork): OfficeEvent {
  const task = { taskId: work.nodeId, title: work.title };
  switch (work.action) {
    case "assign":
      return { kind: "assign", ...task, from: work.from, to: work.to };
    case "review-request":
      return { kind: "review-request", ...task, from: work.from, to: work.to };
    case "approve":
      return { kind: "approve", ...task, by: work.from, owner: work.to };
    case "send-back":
      return { kind: "send-back", ...task, by: work.from, to: work.to };
    default:
      return work.action satisfies never;
  }
}

const STATE_WORDS: Readonly<Record<RoomState, string>> = {
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
