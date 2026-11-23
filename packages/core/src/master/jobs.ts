// 社員の職種のマスタデータ。社員の追加と一覧の職種の名前に使う
import { defineMaster } from "./master.ts";

/** 職種。社長は 1 人で、足せるのは開発担当とレビュー担当 */
export const JOBS = defineMaster([
  { value: "president", label: "社長", note: "仕事を分けて渡し、オーナーと話す" },
  { value: "builder", label: "開発担当", note: "コードを書いて PR を出す" },
  { value: "reviewer", label: "レビュー担当", note: "作った者と別のモデルで差分を見る" },
]);
