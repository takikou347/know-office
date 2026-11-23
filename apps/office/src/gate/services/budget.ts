// Claude の API の月の予算。設定を読んで変え、今日の配分と使った額を出し、配分に届いたら呼び出しを始めさせない (社員が考えるの 3.10)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, ClaudeBudget, dailyAllowanceMicroUsd, DEFAULT_CLAUDE_BUDGET, jstDay, jstDayStart, newId, type Setting } from "@know-office/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { settings } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { clockAt } from "../work/attendance.ts";
import { recordsOf } from "../work/nodes.ts";
import { checkValue } from "./settings.ts";

/** 月の予算の設定のキー */
export const BUDGET_KEY = "claude.budget";

/** 配分に届いた時の通知の種類。日ごとに 1 件にする */
export const BUDGET_PACED_NOTICE = "claude_budget_paced";

/** ドルを百万分の 1 ドルにする */
const MICRO = 1_000_000;

/**
 * 月の予算を最新の版と一緒に読む。行が無いか形が違えば初期値とみなす
 * @param db 今の状態の D1
 * @returns 設定の 1 項目。行が無ければ初期値をバージョン 0 で返す
 */
export async function loadBudget(db: D1Database): Promise<Setting & { value: ClaudeBudget }> {
  const [row] = await drizzle(db)
    .select({ value: settings.value, version: settings.version })
    .from(settings)
    .where(and(eq(settings.key, BUDGET_KEY), eq(settings.scope, "office")))
    .orderBy(desc(settings.version))
    .limit(1);
  // 読めない値で予算を外すと上限に届くので、初期値で抑える
  const parsed = ClaudeBudget.safeParse(row?.value);
  const version = row?.version ?? 0;
  return { key: BUDGET_KEY, value: parsed.success ? parsed.data : DEFAULT_CLAUDE_BUDGET, inherited: version === 0, version };
}

/**
 * 月の予算を変える。読んだ版のままの時だけ書く。額を増やす変更は費用が増えるのでパスキーで確かめる
 * @param db 今の状態の D1
 * @param input 値、読んだ版、理由、今の時刻
 * @param input.value 新しい値
 * @param input.version 読んだ版
 * @param input.reason 理由
 * @param input.now 今の時刻
 * @param stepUp 額を増やす変更の時に呼ぶ、パスキーの確認を求める関数
 * @returns 変えた後の設定
 * @throws validation_failed 値が形に合わない時
 * @throws step_up_required 額を増やす変更で、パスキーの確認が無い時 (stepUp が投げる)
 * @throws conflict 版が違う時
 */
export async function updateBudget(db: D1Database, input: { value: unknown; version: number; reason: string; now: number }, stepUp: () => void): Promise<Setting> {
  const { version, reason, now } = input;
  const value = checkValue(ClaudeBudget, input.value);
  const current = await loadBudget(db);
  if (current.version !== version) throw new AppError("conflict", "バージョンが違う");
  if (value.monthlyUsd > current.value.monthlyUsd || value.taskMaxUsd > current.value.taskMaxUsd) stepUp();
  const next = version + 1;
  // 読んだ版より新しい行が無い時だけ書く 1 文で、同時に変えた 2 つの片方を断る
  const written = await drizzle(db)
    .insert(settings)
    .select(
      sql`SELECT ${newId(clockAt(now))}, ${BUDGET_KEY}, 'office', ${JSON.stringify(value)}, ${next}, 'owner', ${reason}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${settings} WHERE ${settings.key} = ${BUDGET_KEY} AND ${settings.scope} = 'office' AND ${settings.version} >= ${next})`,
    )
    .returning({ id: settings.id });
  if (written.length === 0) throw new AppError("conflict", "バージョンが違う");
  return { key: BUDGET_KEY, value, inherited: false, version: next };
}

/** 今の予算の使い方。額は百万分の 1 ドル */
export type BudgetPace = {
  /** 月の予算 */
  budgetMicroUsd: number;
  /** 今月使った額 (今日を入れる) */
  monthMicroUsd: number;
  /** 今日使った額 */
  todayMicroUsd: number;
  /** 今日の配分 */
  allowanceMicroUsd: number;
  /** 1 つのタスクの上限 */
  taskMaxMicroUsd: number;
  /** 今日の配分か月の予算に届いていれば true。新しい呼び出しを始めない */
  held: boolean;
};

/**
 * 今月と今日に使った額を記録の D1 から足し、今日の配分を出す。バッチ処理とゲートウェイの呼び出しも usage に入るので一緒に数える
 * @param env バインディング
 * @param now 今の時刻
 * @returns 予算の使い方
 */
export async function budgetPace(env: Bindings, now: number): Promise<BudgetPace> {
  const today = jstDay(now);
  const todayStart = jstDayStart(today);
  const monthStart = jstDayStart(`${today.slice(0, 7)}-01`);
  const [{ value }, row] = await Promise.all([
    loadBudget(env.DB),
    recordsOf(env, now)
      .prepare("SELECT coalesce(sum(cost_micro_usd), 0) AS month, coalesce(sum(CASE WHEN at >= ?2 THEN cost_micro_usd ELSE 0 END), 0) AS today FROM usage WHERE at >= ?1")
      .bind(monthStart, todayStart)
      .first<{ month: number; today: number }>(),
  ]);
  const budget = Math.round(value.monthlyUsd * MICRO);
  const month = row?.month ?? 0;
  const todaySpent = row?.today ?? 0;
  const allowance = dailyAllowanceMicroUsd(budget, month - todaySpent, today);
  return {
    budgetMicroUsd: budget,
    monthMicroUsd: month,
    todayMicroUsd: todaySpent,
    allowanceMicroUsd: allowance,
    taskMaxMicroUsd: Math.round(value.taskMaxUsd * MICRO),
    held: month >= budget || todaySpent >= allowance,
  };
}

/**
 * 百万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 百万分の 1 ドル
 * @returns 例 "1.23 ドル"
 */
export function usdText(micro: number): string {
  return `${(micro / MICRO).toFixed(2)} ドル`;
}
