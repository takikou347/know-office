// 条件が合う時だけ 1 行を足す INSERT ... SELECT ... WHERE。読んだ状態のままの時だけ書く batch に入れる
import type { D1Database } from "@cloudflare/workers-types";
import { getTableColumns, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

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
