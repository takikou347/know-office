// その日だけの指示 (勤務の変更) の種類のマスタデータ。画面の選択肢とゲートウェイの確かめに使う (社員と勤怠の 3.4)
import { defineMaster } from "./master.ts";

/** その日だけの指示の種類。延長と早退は終了時刻を持ち、休みは持たない */
export const DAY_ORDER_KINDS = defineMaster([
  { value: "extend", label: "延長", note: "終了時刻を遅くする。パスキーで確かめる" },
  { value: "leave_early", label: "早退", note: "終了時刻を早める" },
  { value: "off", label: "休み", note: "その日は出勤しない" },
]);
