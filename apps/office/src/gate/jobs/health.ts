// 5 分ごとの定期ジョブ。D1 の使った量を見て上限に近い置き場を知らせ、最長時間を過ぎたタスクを止める (ログインと記録の 3.5、自動停止の 3.1)
import { type Clock, newId } from "@know-office/core";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { notices } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { UNCONNECTED_DEPS } from "../guard/deps.ts";
import { checkOverruns } from "../guard/observe.ts";
import { recordError } from "../ledger/errors.ts";
import { STORAGE_LIMIT_BYTES, storageUses } from "../ledger/storage.ts";

/** 上限に対してこの割合に届いたら通知を出す */
const WARN_RATIO = 0.8;
const GB = 1000 ** 3;

/**
 * 置き場の通知の題を作る
 * @param binding 置き場の名前
 * @returns 通知の題
 */
function storageTitle(binding: string): string {
  // 題は、同じ置き場の通知を重ねないための鍵も兼ねる。文を変える時はここだけを変える
  return `記録の置き場 ${binding} が上限の ${String(Math.round(WARN_RATIO * 10))} 割に届いた`;
}

/**
 * 上限の 8 割に届いた置き場があれば通知を出す。同じ置き場の通知は、オーナーが読むまで重ねて出さない
 * @param env バインディング
 * @param clock 時刻
 */
export async function checkStorage(env: Bindings, clock: Clock): Promise<void> {
  const orm = drizzle(env.DB);
  for (const use of await storageUses(env)) {
    if (use.ratio < WARN_RATIO) continue;
    const title = storageTitle(use.binding);
    const [open] = await orm
      .select({ id: notices.id })
      .from(notices)
      .where(and(eq(notices.kind, "storage"), eq(notices.title, title), isNull(notices.readAt)))
      .limit(1);
    if (open) continue;
    await orm.insert(notices).values({
      id: newId(clock),
      at: clock.now(),
      level: "warn",
      kind: "storage",
      title,
      body: `${(use.bytes / GB).toFixed(1)}GB / ${String(STORAGE_LIMIT_BYTES / GB)}GB を使っている`,
      scope: "office",
    });
  }
}

/**
 * 定期ジョブを走らせる。失敗は投げずにエラーログに残し、次の 5 分でまた試す
 * @param env バインディング
 * @param ctx 返事の後も処理を続けさせる waitUntil
 * @param ctx.waitUntil 待たせる Promise を渡す
 * @param clock 時刻
 */
export function runScheduled(env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }, clock: Clock): void {
  ctx.waitUntil(
    checkStorage(env, clock).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "storage_check_failed", error }, clock)),
  );
  // 1 つのタスクの最長時間は 5 分ごとに見る。最長の 4 時間に比べて十分に細かい
  ctx.waitUntil(
    checkOverruns(env, clock.now(), UNCONNECTED_DEPS).catch((error: unknown) => recordError(env, { source: "job", level: "error", code: "overrun_check_failed", error }, clock)),
  );
}
