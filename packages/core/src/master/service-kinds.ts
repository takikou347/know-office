// サービスの種類のマスタデータ。種類ごとに管理する物が変わる (サービスと拡張の 3.2)
import { defineMaster } from "./master.ts";

/** サービスの種類 */
export const SERVICE_KINDS = defineMaster([
  { value: "library", label: "ライブラリ", note: "版、npm への公開、使っているサービス" },
  { value: "web_app", label: "Web アプリ", note: "本番へのデプロイと戻し、利用者数、失敗率" },
  { value: "content", label: "コンテンツ", note: "公開した物と読まれた数" },
]);
