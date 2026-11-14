// マイグレーションを流した D1 のテーブルとカラムが Drizzle のスキーマと合う事を確かめる。データの 4 章
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as main from "../../src/gate/db/main.ts";
import * as records from "../../src/gate/db/records.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import type { D1Database } from "@cloudflare/workers-types";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
});
afterAll(() => d1.dispose());

/**
 * スキーマのテーブルとカラムを並べる
 * @param schema Drizzle のスキーマのモジュール
 * @returns テーブルの名前からカラムの名前の並び
 */
function fromSchema(schema: Record<string, unknown>): Record<string, string[]> {
  const tables = Object.values(schema).filter((v): v is SQLiteTable => v instanceof SQLiteTable);
  return Object.fromEntries(tables.map((t) => getTableConfig(t)).map((c) => [c.name, c.columns.map((col) => col.name).toSorted()]));
}

/**
 * D1 のテーブルとカラムを並べる
 * @param db D1
 * @returns テーブルの名前からカラムの名前の並び
 */
async function fromD1(db: D1Database): Promise<Record<string, string[]>> {
  const { results } = await db
    .prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE '\\_%' ESCAPE '\\' AND m.name NOT LIKE 'sqlite%'")
    .all<{ t: string; c: string }>();
  const out: Record<string, string[]> = {};
  for (const { t, c } of results) out[t] = [...(out[t] ?? []), c].toSorted();
  return out;
}

describe("D1 のスキーマ", () => {
  it("DB のマイグレーションがスキーマと合う", async () => {
    expect(await fromD1(d1.DB)).toEqual(fromSchema(main));
  });

  it("REC_<年> のマイグレーションがスキーマと合う", async () => {
    expect(await fromD1(d1.REC_2026)).toEqual(fromSchema(records));
  });
});
