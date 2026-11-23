// 段階を移す理由のマスタデータ。移す先ごとによくある理由を並べ、ほかは画面の「その他」で書く。理由は文として残すので入口は並びに無い文も受ける (サービスと拡張の 3.1)
import { defineMaster, type Master } from "./master.ts";

/** 段階を移す理由。移す先の段階ごと */
export const SERVICE_MOVE_REASONS = {
  idea: defineMaster([{ value: "もう一度考える", label: "もう一度考える" }]),
  study: defineMaster([
    { value: "調べる価値がある", label: "調べる価値がある" },
    { value: "売り上げが見込める", label: "売り上げが見込める" },
    { value: "自分で使いたい", label: "自分で使いたい" },
  ]),
  prototype: defineMaster([
    { value: "調べた結果、作る価値がある", label: "調べた結果、作る価値がある" },
    { value: "小さく試せる", label: "小さく試せる" },
  ]),
  service: defineMaster([
    { value: "試作で確かめられた", label: "試作で確かめられた" },
    { value: "本番に出せる形になった", label: "本番に出せる形になった" },
  ]),
  operation: defineMaster([{ value: "公開して使い始めた", label: "公開して使い始めた" }]),
  dropped: defineMaster([
    { value: "費用に見合わない", label: "費用に見合わない" },
    { value: "似た物がもうある", label: "似た物がもうある" },
    { value: "今は優先しない", label: "今は優先しない" },
  ]),
  closed: defineMaster([
    { value: "使われていない", label: "使われていない" },
    { value: "別のサービスに移した", label: "別のサービスに移した" },
    { value: "費用に見合わない", label: "費用に見合わない" },
  ]),
} as const satisfies Record<string, Master<string>>;
