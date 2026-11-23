// 社員に選べる Claude のモデルのマスタデータ。社員の追加と設定のモデルの選ぶ欄に使う
import { defineMaster } from "./master.ts";

/** 社員に選べるモデル。並びは単価の高い順 */
export const MODELS = defineMaster([
  { value: "claude-opus-5-5", label: "Opus 5.5", note: "いちばん賢く、単価がいちばん高い" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "速さと賢さの釣り合い。単価は Opus の半分" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", note: "速く安い。軽いタスク向け" },
]);
