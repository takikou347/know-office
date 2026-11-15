// 社員の状態 (働く、待つ、止まる、退勤) の印と言葉。ダッシュボード、社員と仕事、オフィスで同じ物を使う
import { Status, type StatusKind } from "knowidea-ui";
import type { Staff } from "../mock.ts";

/** 状態ごとの印の種類と言葉 */
export const STAFF_STATES: Readonly<Record<Staff["state"], { kind: StatusKind; label: string }>> = {
  working: { kind: "working", label: "働いている" },
  paused: { kind: "paused", label: "待っている" },
  stopped: { kind: "stopped", label: "止めた" },
  off: { kind: "neutral", label: "退勤した" },
};

/**
 * 社員の今の状態を印と字で出す
 * @param props.s 出す社員
 * @returns 状態の印
 */
export function StaffStatus({ s }: { /** 出す社員 */ s: Staff }) {
  const st = STAFF_STATES[s.state];
  return <Status kind={st.kind} label={st.label} />;
}
