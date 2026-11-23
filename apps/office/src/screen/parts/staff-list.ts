// 画面で社員を選ぶ欄と並びのために、在籍の社員の一覧を読む (社員と勤怠の 3.4)
import { StaffOverview } from "@know-office/core";
import { z } from "zod";
import { useLoad } from "./load.tsx";

/** 選ぶ欄の 1 つ。値は社員 ID、名前は役の名前 */
export type StaffOption = { value: string; label: string };

/**
 * 在籍の社員を、選ぶ欄の並び (社長、作った順) で読む
 * @param tick 増やすと読み直す
 * @returns 選ぶ欄の並び。読み込み中と失敗は空
 */
export function useStaffOptions(tick = 0): StaffOption[] {
  const loaded = useLoad(z.array(StaffOverview), (a) => a.api.v1.staff.$get({ query: {} }), tick);
  return loaded.state === "ok" ? loaded.data.map((s) => ({ value: s.id, label: s.role })) : [];
}
