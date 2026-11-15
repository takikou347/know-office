// セキュリティの画面に出す名前。範囲、社員、シグナル、判定、基準の項目と、基準の値の単位
import { GuardSignal, type GuardScope, StaffId, type StopVerdict, type Thresholds } from "@know-office/core";
import type { z } from "zod";

/** 範囲の名前 */
export const SCOPE_LABEL: Record<GuardScope, string> = { task: "タスク", staff: "社員", service: "サービス", office: "全体" };

/** 社員の名前 */
export const STAFF_LABEL: Record<StaffId, string> = { president: "社長", builder: "開発担当", reviewer: "レビュー担当" };

/** 判定の名前 */
export const VERDICT_LABEL: Record<z.infer<typeof StopVerdict>, string> = { correct: "正しく止めた", false: "誤って止めた", unknown: "分からない" };

/** シグナルの名前 */
const SIGNAL_LABEL: Record<GuardSignal, string> = {
  rule_denied: "ルールの外の操作",
  repeated_failure: "同じ失敗の繰り返し",
  unchecked_merge: "チェックを通らないマージ",
  task_overrun: "1 つのタスクの最長時間",
  staff_rule_denied: "社員のルールの外の操作",
  token_rate: "トークンの速さ",
  tool_rate: "操作の速さ",
  exfiltration: "外部の文章の後の持ち出し",
  deploy_failure: "デプロイの後の失敗",
  library_build: "ライブラリの組むチェック",
  certain_fraud: "確かな不正",
  stacked_suspicion: "重なった怪しい動き",
  manual: "手で止めた",
};

/**
 * シグナルの名前を返す。知らない名前はそのまま出す
 * @param signal シグナル
 * @returns 名前
 */
export function signalLabel(signal: string): string {
  const known = GuardSignal.safeParse(signal);
  return known.success ? SIGNAL_LABEL[known.data] : signal;
}

/**
 * 止めた相手の名前を返す。社員は役の名前、全体は「すべての社員」、サービスは渡した名前、ほかは ID をそのまま出す
 * @param scope 範囲
 * @param target 相手
 * @param services サービス ID から名前への対応
 * @returns 名前
 */
export function targetLabel(scope: GuardScope, target: string, services: ReadonlyMap<string, string> = new Map()): string {
  if (scope === "office") return "すべての社員";
  const staff = StaffId.safeParse(target);
  if (scope === "staff" && staff.success) return STAFF_LABEL[staff.data];
  if (scope === "service") return services.get(target) ?? `サービス ${target}`;
  return `${SCOPE_LABEL[scope]} ${target}`;
}

/** 基準の値の単位。ms は分で、bp は % で出して入れる */
export type ThresholdUnit = "ms" | "bp" | "count" | "times" | "days";

/** 基準の 1 項目。並びは自動停止の 3.1 の表の順 */
export type ThresholdItem = { key: keyof Thresholds; label: string; unit: ThresholdUnit };

/** 基準の項目。`core` の `Thresholds` のキーと同じ */
export const THRESHOLD_ITEMS: readonly ThresholdItem[] = [
  { key: "ruleMergeMs", label: "同じタスク、同じ操作、同じ相手のルールの外の操作を 1 回にまとめる間", unit: "ms" },
  { key: "repeatedFailures", label: "タスクを止める、同じ失敗の続いた数", unit: "count" },
  { key: "taskMaxMs", label: "1 つのタスクの最長時間", unit: "ms" },
  { key: "staffRuleDenied", label: "社員を止める、ルールの外の操作の数", unit: "count" },
  { key: "staffWindowMs", label: "社員のルールの外の操作を数える間", unit: "ms" },
  { key: "bucketMs", label: "速さを数える 1 区切り", unit: "ms" },
  { key: "rateMultiplier", label: "速すぎるとする、普段の値からの倍率", unit: "times" },
  { key: "rateBuckets", label: "社員を止める、速すぎる区切りの続いた数", unit: "count" },
  { key: "baselineDays", label: "普段の値を作る日数", unit: "days" },
  { key: "deployWindowMs", label: "デプロイの後に失敗率を見る間", unit: "ms" },
  { key: "deployFailureBp", label: "デプロイの後の失敗率の下限", unit: "bp" },
  { key: "deployMultiplier", label: "前のバージョンに戻す、デプロイの前の失敗率からの倍率", unit: "times" },
  { key: "deployMinResponses", label: "失敗率で判断する返事の数の下限", unit: "count" },
  { key: "loginWindowMs", label: "新しい国のログインの後に重なりを見る間", unit: "ms" },
  { key: "ownerReadWindowMs", label: "オーナーの情報の読み出しを数える間", unit: "ms" },
  { key: "ownerReads", label: "全体を止める、オーナーの情報の読み出しの数", unit: "count" },
  { key: "nearBp", label: "近かったとする、基準に対する割合", unit: "bp" },
  { key: "nearMergeMs", label: "同じシグナルと相手の近かったを 1 行にまとめる間", unit: "ms" },
];

const UNIT_LABEL: Record<ThresholdUnit, string> = { ms: "分", bp: "%", count: "回", times: "倍", days: "日" };
const UNIT_SCALE: Record<ThresholdUnit, number> = { ms: 60_000, bp: 100, count: 1, times: 1, days: 1 };

/**
 * 基準の値を、画面に出す数にする。時間は分、率は % にする
 * @param unit 単位
 * @param value 置いてある値
 * @returns 画面に出す数
 */
export function shownValue(unit: ThresholdUnit, value: number): number {
  return value / UNIT_SCALE[unit];
}

/**
 * 画面で入れた数を、置く値にする
 * @param unit 単位
 * @param shown 画面で入れた数
 * @returns 置く値。倍率のほかは整数に丸める
 */
export function storedValue(unit: ThresholdUnit, shown: number): number {
  // 倍率のほかは整数で置く。0.1 分のような数を掛けた時の端数を残さない
  return unit === "times" ? shown : Math.round(shown * UNIT_SCALE[unit]);
}

/**
 * 基準の値を、単位を付けた文にする
 * @param unit 単位
 * @param value 置いてある値
 * @returns 「10 分」のような文
 */
export function thresholdText(unit: ThresholdUnit, value: number): string {
  return `${String(shownValue(unit, value))} ${UNIT_LABEL[unit]}`;
}

/**
 * 単位の名前を返す
 * @param unit 単位
 * @returns 名前
 */
export function unitLabel(unit: ThresholdUnit): string {
  return UNIT_LABEL[unit];
}
