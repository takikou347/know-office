// 案の月の売り上げの見込みのマスタデータ。値は 100 万分の 1 ドルの整数の文字列。並びに無い値も入口は受ける (サービスと拡張の 3.1)
import { defineMaster } from "./master.ts";

/** 案の月の売り上げの見込み */
export const SERVICE_REVENUE_ESTIMATES = defineMaster([
  { value: "0", label: "0 ドル" },
  { value: "10000000", label: "10 ドル" },
  { value: "50000000", label: "50 ドル" },
  { value: "100000000", label: "100 ドル" },
  { value: "300000000", label: "300 ドル" },
  { value: "1000000000", label: "1000 ドル" },
  { value: "5000000000", label: "5000 ドル" },
]);
