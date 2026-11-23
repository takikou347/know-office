// 案の使う人のマスタデータ。元の案を直す時に選ぶ。並びに無い値も入口は受け、画面は今の値を選び肢の頭に足す (サービスと拡張の 3.1)
import { defineMaster } from "./master.ts";

/** 案の使う人 */
export const SERVICE_USERS = defineMaster([
  { value: "オーナー自身", label: "オーナー自身" },
  { value: "開発者", label: "開発者" },
  { value: "個人の利用者", label: "個人の利用者" },
  { value: "小さな会社", label: "小さな会社" },
  { value: "企業", label: "企業" },
]);
