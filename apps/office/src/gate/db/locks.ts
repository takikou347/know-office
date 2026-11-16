// 同じ時に 1 つだけ動かす操作の錠。取る時は 1 文の条件付きの書きで、切れた錠だけを取り直す (データの 2 章)
import type { D1Database } from "@cloudflare/workers-types";
import { and, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { locks } from "./main.ts";

/**
 * 錠を取る。無いか切れていれば取り、ほかが持っていれば取らない
 * @param db 今の状態の D1
 * @param input 錠の名前、取る者、今の時刻、持つ長さ
 * @param input.name 錠の名前
 * @param input.holder 取る者。外す時に同じ値を渡す
 * @param input.now 今の時刻
 * @param input.ttlMs 持つ長さ。落ちて外せなかった錠は、これを過ぎるとほかが取れる
 * @returns 取れたか
 */
export async function claimLock(db: D1Database, input: { name: string; holder: string; now: number; ttlMs: number }): Promise<boolean> {
  const taken = await drizzle(db)
    .insert(locks)
    .values({ name: input.name, holder: input.holder, until: input.now + input.ttlMs })
    .onConflictDoUpdate({ target: locks.name, set: { holder: input.holder, until: input.now + input.ttlMs }, setWhere: lte(locks.until, sql`${input.now}`) })
    .returning({ name: locks.name });
  return taken.length > 0;
}

/**
 * 自分の取った錠を外す。ほかが取り直した錠は外さない
 * @param db 今の状態の D1
 * @param name 錠の名前
 * @param holder 取った者
 */
export async function releaseLock(db: D1Database, name: string, holder: string): Promise<void> {
  await drizzle(db)
    .delete(locks)
    .where(and(eq(locks.name, name), eq(locks.holder, holder)));
}
