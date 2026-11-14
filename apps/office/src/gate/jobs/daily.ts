// 毎日 0 時 5 分の定期ジョブ。前の日の日ごとの集計を、社員 DO を通して作り直す (社員と勤怠の 3.6)
import { type Clock, jstDay, jstDayStart, StaffId } from "@know-office/core";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";

/** 日本時間の 0 時 5 分。Cron は協定世界時で書くので 15 時 5 分になる。wrangler.jsonc の triggers.crons に同じ文字列を置く */
export const DAILY_CRON = "5 15 * * *";

/**
 * 前の日の集計を、社員ごとに社員 DO の鎖で作り直す。区分を書いている途中の DO と食い違わないよう、D1 を直に書かない
 * @param env バインディング
 * @param clock 時刻
 * @returns 無し
 */
export async function rebuildYesterday(env: Bindings, clock: Clock): Promise<void> {
  const now = clock.now();
  const yesterday = jstDay(jstDayStart(jstDay(now)) - 1);
  await Promise.all(StaffId.options.map((id) => env.STAFF.get(env.STAFF.idFromName(id)).rebuildDay(yesterday, now)));
}

/**
 * 0 時 5 分の定期ジョブを走らせる。失敗は投げずにエラーログに残す。次の日の 0 時 5 分か、出勤や訂正でまた作り直す
 * @param env バインディング
 * @param ctx 返事の後も処理を続けさせる waitUntil
 * @param ctx.waitUntil 待たせる Promise を渡す
 * @param clock 時刻
 */
export function runDaily(env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }, clock: Clock): void {
  ctx.waitUntil(
    rebuildYesterday(env, clock).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "daily_totals_rebuild_failed", error }, clock)),
  );
}
