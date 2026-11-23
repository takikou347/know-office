// Claude のモデルの単価表と、役ごとに使えるモデルと、使用の上限の見分け。費用は百万分の 1 ドルで出す (社員が考えるの 3.4、サービスと拡張の 3.5)
import { ClaudeErrorBody, type SpendLimitKind } from "./schemas/claude.ts";
import type { StaffJob } from "./schemas/workday.ts";

/** レビュー担当のモデル。作った者と別のモデルで見るので、開発担当より上のモデルにする */
export const OPUS = "claude-opus-5-5";
/** 社長と開発担当のモデル。ゲートウェイのバッチ処理と止めた記録を聞く時もこれを使う */
export const SONNET = "claude-sonnet-5-5";
/** 軽いタスク (題を付ける、要約するなど) のモデル。SDK が裏で呼ぶので、どの役にも許す */
export const HAIKU = "claude-haiku-5-5";

/** 開発環境の Claude のプロキシが、代わりの Claude API に送る要求に付ける社員 ID のヘッダー。プロキシは鍵を替えるので、代わりの Claude API はこれで社員ごとに積んだ返事を選ぶ。本番とプレビューでは付けない */
export const DEV_STAFF_HEADER = "x-know-dev-staff";

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

/** 社員に選べるモデル。画面の選ぶ欄の元 */
export const SELECTABLE_MODELS: readonly ClaudeModel[] = [OPUS, SONNET, HAIKU];

/** 職種ごとの初期のモデル。社員を足す時の選ぶ欄の初期値。月の予算に収めるため、レビュー担当だけ Opus にする */
export const JOB_MODEL: Record<StaffJob, ClaudeModel> = { president: SONNET, reviewer: OPUS, builder: SONNET };

/**
 * 選べるモデルかを確かめる
 * @param model モデルの名前
 * @returns 選べるモデルなら true
 */
export function isStaffModel(model: string): model is ClaudeModel {
  return SELECTABLE_MODELS.some((m) => m === model);
}

/**
 * 社員が使えるモデルを返す。社員の設定のモデルと、SDK が裏で呼ぶ軽いモデル
 * @param model 社員の設定のモデル
 * @returns 使えるモデル。先頭が社員のモデル
 */
export function allowedModels(model: ClaudeModel): readonly ClaudeModel[] {
  return model === HAIKU ? [HAIKU] : [model, HAIKU];
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

/** 見分けた使用の上限。message は Claude の API の文のまま */
export type ClaudeSpendLimit = { kind: SpendLimitKind; message: string };

/** Console で決めた組織の上限の 400 の文の頭。出典: platform.claude.com/docs/en/api/rate-limits の「Setting your own spend limit」 */
const ORGANIZATION_LIMIT = "You have reached your specified API usage limits";
/** Console で決めた workspace の上限の 400 の文の頭。出典は上と同じ */
const WORKSPACE_LIMIT = "You have reached your specified workspace API usage limits";

/**
 * Claude の API の失敗が使用の上限 (待っても直らない上限) かを見分ける
 * 出典: platform.claude.com/docs/en/api/rate-limits の「Reaching your spend cap」(429 rate_limit_error の error.details.error_code が enforced_spend_limit_reached) と「Setting your own spend limit」(400 invalid_request_error)、/docs/en/api/errors の 402 billing_error
 * @param status 返事のステータス
 * @param body 返事の本文を JSON として読んだ物
 * @returns 使用の上限なら種類と文。ほかと、形が違う時は null
 */
export function claudeSpendLimit(status: number, body: unknown): ClaudeSpendLimit | null {
  const parsed = ClaudeErrorBody.safeParse(body);
  if (!parsed.success) return null;
  const { type, message, details } = parsed.data.error;
  if (status === 429 && type === "rate_limit_error" && details?.error_code === "enforced_spend_limit_reached") return { kind: "monthly", message };
  if (status === 400 && type === "invalid_request_error" && message.startsWith(WORKSPACE_LIMIT)) return { kind: "workspace", message };
  if (status === 400 && type === "invalid_request_error" && message.startsWith(ORGANIZATION_LIMIT)) return { kind: "organization", message };
  if (status === 402 && type === "billing_error") return { kind: "billing", message };
  return null;
}

/**
 * 今日の配分を出す。今月の予算から今日より前に使った額を引き、今日を入れた月の残りの日数で割る。端数は切り捨てる
 * @param budgetMicroUsd 月の予算 (百万分の 1 ドル)
 * @param spentBeforeTodayMicroUsd 今月の今日より前に使った額
 * @param today 日本時間の今日 YYYY-MM-DD
 * @returns 今日の配分 (百万分の 1 ドル)。予算を使い切っていれば 0
 */
export function dailyAllowanceMicroUsd(budgetMicroUsd: number, spentBeforeTodayMicroUsd: number, today: string): number {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  // 次の月の 0 日は今月の最後の日
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daysLeft = lastDay - day + 1;
  const left = budgetMicroUsd - spentBeforeTodayMicroUsd;
  if (left <= 0) return 0;
  return Math.floor(left / Math.max(1, daysLeft));
}

