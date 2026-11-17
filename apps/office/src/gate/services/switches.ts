// 費用の出る口を開くか閉じるかの設定。時間外の呼び出しと会話の言葉の指示が同じ形で持つ (社員と勤怠の 3.2、3.4)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, ChatOrders, DEFAULT_CHAT_ORDERS, DEFAULT_OFF_HOURS_CALL, newId, OffHoursCall, type Setting } from "@know-office/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ZodType } from "zod";
import { settings } from "../db/main.ts";
import { clockAt } from "../work/attendance.ts";
import { checkValue } from "./settings.ts";

/** 開くか閉じるかと 1 日の回数。2 つの設定で同じ形 */
type SwitchValue = OffHoursCall & ChatOrders;

/** 費用の出る口の設定 1 つ。キー、値の形、閉じた初期値 */
export type CostSwitch = { key: string; schema: ZodType<SwitchValue>; fallback: SwitchValue };

/** 時間外の呼び出し。perDay は社員ごとの 1 日の回数 */
export const OFF_HOURS_CALL = { key: "workday.offHoursCall", schema: OffHoursCall, fallback: DEFAULT_OFF_HOURS_CALL } satisfies CostSwitch;

/** 会話の言葉の指示。perDay は office 全体の 1 日の抜き出しの回数 */
export const CHAT_ORDERS = { key: "workday.chatOrders", schema: ChatOrders, fallback: DEFAULT_CHAT_ORDERS } satisfies CostSwitch;

/** このファイルが受け持つ設定の並び。設定の一覧に出す順 */
export const COST_SWITCHES = [OFF_HOURS_CALL, CHAT_ORDERS] as const;

/**
 * 設定を最新の版と一緒に読む。行が無いか形が違えば、閉じた初期値とみなす
 * @param db 今の状態の D1
 * @param sw 設定
 * @returns 設定の 1 項目。行が無ければ初期値をバージョン 0 で返す
 */
export async function loadSwitch(db: D1Database, sw: CostSwitch): Promise<Setting & { value: SwitchValue }> {
  const [row] = await drizzle(db)
    .select({ value: settings.value, version: settings.version })
    .from(settings)
    .where(and(eq(settings.key, sw.key), eq(settings.scope, "office")))
    .orderBy(desc(settings.version))
    .limit(1);
  // 費用の出る口なので、読めない値は開いているとみなさない
  const parsed = sw.schema.safeParse(row?.value);
  const version = row?.version ?? 0;
  return { key: sw.key, value: parsed.success ? parsed.data : sw.fallback, inherited: version === 0, version };
}

/**
 * 設定を変える。読んだ版のままの時だけ書く
 * @param db 今の状態の D1
 * @param sw 設定
 * @param input 値、読んだ版、理由、今の時刻
 * @param input.value 新しい値
 * @param input.version 読んだ版
 * @param input.reason 理由
 * @param input.now 今の時刻
 * @param stepUp 開く変更か回数を増やす変更の時に呼ぶ、パスキーの確認を求める関数
 * @returns 変えた後の設定
 * @throws validation_failed 値が形に合わない時
 * @throws step_up_required 開くか回数を増やす変更で、パスキーの確認が無い時 (stepUp が投げる)
 * @throws conflict 版が違う時
 */
export async function updateSwitch(
  db: D1Database,
  sw: CostSwitch,
  input: { value: unknown; version: number; reason: string; now: number },
  stepUp: () => void,
): Promise<Setting> {
  const { version, reason, now } = input;
  const value = checkValue(sw.schema, input.value);
  const current = await loadSwitch(db, sw);
  // 古い版のまま送った変更は、今の値と比べず先に断る
  if (current.version !== version) throw new AppError("conflict", "バージョンが違う");
  // 開く、または回数を増やす変更は費用が増える
  if ((value.enabled && !current.value.enabled) || value.perDay > current.value.perDay) stepUp();
  const next = version + 1;
  // 読んだ版より新しい行が無い時だけ書く 1 文で、同時に変えた 2 つの片方を断る
  const written = await drizzle(db)
    .insert(settings)
    .select(
      sql`SELECT ${newId(clockAt(now))}, ${sw.key}, 'office', ${JSON.stringify(value)}, ${next}, 'owner', ${reason}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${settings} WHERE ${settings.key} = ${sw.key} AND ${settings.scope} = 'office' AND ${settings.version} >= ${next})`,
    )
    .returning({ id: settings.id });
  if (written.length === 0) throw new AppError("conflict", "バージョンが違う");
  return { key: sw.key, value, inherited: false, version: next };
}
