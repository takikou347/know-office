// 記録の内訳で集める期間のマスタデータ。選んだ月か、期間を決めない累計
import { defineMaster } from "./master.ts";

/** 記録の内訳で集める期間 */
export const RECORD_SPANS = defineMaster([
  { value: "month", label: "この月" },
  { value: "all", label: "累計" },
]);

/** 集める期間の値 */
export type RecordSpan = (typeof RECORD_SPANS)[number]["value"];
