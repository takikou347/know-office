// Claude のモデルの単価表と、役ごとに使えるモデル。費用は百万分の 1 ドルで出す (社員が考えるの 3.3)
import type { StaffId } from "./schemas/workday.ts";

/** 社長とレビュー担当のモデル */
export const OPUS = "claude-opus-5-5";
/** 開発担当のモデル */
export const SONNET = "claude-sonnet-5-5";
/** 軽いタスク (題を付ける、要約するなど) のモデル。SDK が裏で呼ぶので、どの役にも許す */
export const HAIKU = "claude-haiku-5-5";

/** 単価表にあるモデル */
export type ClaudeModel = typeof OPUS | typeof SONNET | typeof HAIKU;

/** 1 回の呼び出しで使ったトークン */
export type ClaudeUsage = {
  /** 読み直しでない入力 */
  inputTokens: number;
  /** 出力 */
  outputTokens: number;
  /** 割引で読み直した入力 */
  cacheReadTokens: number;
  /** 読み直しのために書き込んだ入力の合計 (5 分と 1 時間) */
  cacheWriteTokens: number;
  /** cacheWriteTokens のうち 1 時間の書き込み。無ければ 0 */
  cacheWrite1hTokens?: number;
};

/** 1 トークンあたりの単価。百万分の 1 ドルの千分の 1 で持ち、小数の誤差を出さない */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };

/** 入力の合計がこれを超えると、軽いタスクのモデルは高い方の単価になる */
const HAIKU_LONG_PROMPT = 100_000;
const HAIKU_SHORT: Price = { input: 100, output: 500, cacheRead: 10, cacheWrite: 125, cacheWrite1h: 200 };
const HAIKU_LONG: Price = { input: 500, output: 2500, cacheRead: 50, cacheWrite: 625, cacheWrite1h: 1000 };

/** Anthropic の単価表。読み直しは入力の 0.05 倍 (Haiku は 0.1 倍)、書き込みは 5 分が 1.25 倍、1 時間が 2 倍 */
const PRICES: Record<typeof OPUS | typeof SONNET, Price> = {
  [OPUS]: { input: 4000, output: 20_000, cacheRead: 200, cacheWrite: 5000, cacheWrite1h: 8000 },
  [SONNET]: { input: 2000, output: 10_000, cacheRead: 100, cacheWrite: 2500, cacheWrite1h: 4000 },
};

/** 役ごとに使えるモデル。先頭がその役のモデル */
const ROLE_MODELS: Record<StaffId, readonly ClaudeModel[]> = {
  president: [OPUS, HAIKU],
  reviewer: [OPUS, HAIKU],
  builder: [SONNET, HAIKU],
};

/**
 * 社員の役で使えるモデルを返す
 * @param staffId 社員 ID
 * @returns 使えるモデル。先頭がその役のモデル
 */
export function allowedModels(staffId: StaffId): readonly ClaudeModel[] {
  return ROLE_MODELS[staffId];
}

/**
 * 使ったトークンから費用を出す。端数は切り上げる
 * @param model モデル
 * @param usage 使ったトークン
 * @returns 百万分の 1 ドル
 */
export function costMicroUsd(model: ClaudeModel, usage: ClaudeUsage): number {
  return Math.ceil(milliMicroUsd(model, usage) / 1000);
}

/**
 * バッチ処理で使ったトークンから費用を出す。単価は 1 件ずつの半分で、半分にした後で端数を切り上げる
 * @param model モデル
 * @param usage 使ったトークン
 * @returns 百万分の 1 ドル
 */
export function batchCostMicroUsd(model: ClaudeModel, usage: ClaudeUsage): number {
  return Math.ceil(milliMicroUsd(model, usage) / 2000);
}

/**
 * 使ったトークンの費用を、百万分の 1 ドルの千分の 1 で出す
 * @param model モデル
 * @param usage 使ったトークン
 * @returns 百万分の 1 ドルの千分の 1
 */
function milliMicroUsd(model: ClaudeModel, usage: ClaudeUsage): number {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const price = model === HAIKU ? (prompt > HAIKU_LONG_PROMPT ? HAIKU_LONG : HAIKU_SHORT) : PRICES[model];
  const hour = usage.cacheWrite1hTokens ?? 0;
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    (usage.cacheWriteTokens - hour) * price.cacheWrite +
    hour * price.cacheWrite1h
  );
}
