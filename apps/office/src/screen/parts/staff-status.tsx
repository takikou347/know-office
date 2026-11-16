// 社員の状態の印と言葉。ダッシュボード、社員と仕事、オフィスで同じ物を使う
import type { StaffState } from "@know-office/core";
import { Status, type StatusKind } from "knowidea-ui";

/** 出す状態。社員 DO の状態と、オフィスの仮のデータの待っている (paused) */
export type ShownState = StaffState | "paused";

/** 状態ごとの印の種類と言葉 */
export const STAFF_STATES: Readonly<Record<ShownState, { kind: StatusKind; label: string }>> = {
  working: { kind: "working", label: "働いている" },
  wrapping: { kind: "working", label: "片付けている" },
  called: { kind: "working", label: "呼ばれて働いている" },
  waiting: { kind: "paused", label: "待っている" },
  paused: { kind: "paused", label: "待っている" },
  stopped: { kind: "stopped", label: "止めた" },
  off: { kind: "neutral", label: "退勤した" },
};

/** 働いている数に入れる状態 */
export const AT_WORK: readonly ShownState[] = ["working", "wrapping", "called"];

export interface StaffStatusProps {
  /** 社員の今の状態 */
  state: ShownState;
}

/**
 * 社員の今の状態を印と字で出す
 * @param props 状態
 * @returns 状態の印
 */
export function StaffStatus({ state }: StaffStatusProps) {
  const st = STAFF_STATES[state];
  return <Status kind={st.kind} label={st.label} />;
}
