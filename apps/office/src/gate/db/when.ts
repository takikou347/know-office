// 条件が合う時だけ 1 行を足す INSERT ... SELECT ... WHERE。読んだ状態のままの時だけ書く batch に入れる
import type { D1Database } from "@cloudflare/workers-types";
import { getTableColumns, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";

/**
 * 条件が合う時だけ行を足す文を作る。値はカラムの定義の順に並べ、JSON のカラムは文字列に直す
 * @param db D1
 * @param table 足すテーブル
 * @param row 足す行。全部のカラムを持つ
 * @param when 足す条件
 * @returns D1 の batch に渡す文
 */
export function insertWhen<T extends SQLiteTable>(db: D1Database, table: T, row: T["$inferSelect"], when: SQL) {
  const values = Object.entries(getTableColumns(table)).map(([key, column]) => sql`${column.mapToDriverValue(Reflect.get(row, key))}`);
  return drizzle(db)
    .insert(table)
    .select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${when}`);
}

const RunResult = z.object({ meta: z.object({ changes: z.number() }).loose() }).loose();

/**
 * 条件が合う時だけ行を足し、足せたかを返す
 * @param db D1
 * @param table 足すテーブル
 * @param row 足す行。全部のカラムを持つ
 * @param when 足す条件
 * @returns 足せたら true
 */
export async function insertedWhen<T extends SQLiteTable>(db: D1Database, table: T, row: T["$inferSelect"], when: SQL): Promise<boolean> {
  const result: unknown = await insertWhen(db, table, row, when).run();
  return RunResult.parse(result).meta.changes > 0;
}
