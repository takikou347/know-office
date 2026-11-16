// テストの D1 の手伝いが、2 回目からも前のテストの中身を残さず、マイグレーションの直後と同じ物を渡す事を確かめる
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestD1, resetLedger, resetMain } from "../helpers/d1.ts";

/**
 * 全部のテーブルの行と、トリガーの名前を読む
 * @param db 読む D1
 * @returns テーブルごとの行と、トリガーの名前
 */
async function dump(db: D1Database): Promise<{ rows: Record<string, unknown[]>; triggers: string[] }> {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables.results) rows[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  const triggers = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string }>();
  return { rows, triggers: triggers.results.map((t) => t.name) };
}

/**
 * 追記専用と入れ替えのできる表、マイグレーションが入れた表に書く
 * @param db DB
 */
async function scribble(db: D1Database): Promise<void> {
  await db.prepare("INSERT INTO login_attempts (id, at, ip, kind, ok) VALUES ('a', 1, '1.1.1.1', 'access', 0)").run();
  await db.prepare("DELETE FROM staff WHERE id = 'reviewer'").run();
}

describe("テストの D1", () => {
  it("2 回目に渡す D1 と R2 は、前のテストが書いた物を持たず、マイグレーションの直後と同じ行とトリガーを持つ", async () => {
    const first = await createTestD1();
    const fresh = { db: await dump(first.DB), rec: await dump(first.REC_2026) };
    await scribble(first.DB);
    await first.REC_2026.prepare("INSERT INTO audit_log (id, at, actor, action, target, scope, prev_hash, hash) VALUES ('x', 1, 'a', 'b', 'c', 'office', 'p', 'h')").run();
    await first.FILES.put("t/1", "x");

    const second = await createTestD1();
    expect(await dump(second.DB)).toEqual(fresh.db);
    expect(await dump(second.REC_2026)).toEqual(fresh.rec);
    expect((await second.FILES.list()).objects).toEqual([]);
    // 戻したトリガーも効いている
    await second.DB.prepare("INSERT INTO login_attempts (id, at, ip, kind, ok) VALUES ('b', 1, '1.1.1.1', 'access', 0)").run();
    await expect(second.DB.prepare("DELETE FROM login_attempts").run()).rejects.toThrow("append only");
  });

  it("resetMain と resetLedger は、表の形を変えたテストの後も、マイグレーションの直後に戻す", async () => {
    const d1 = await createTestD1();
    const fresh = { db: await dump(d1.DB), rec: await dump(d1.REC_2027) };
    await scribble(d1.DB);
    await d1.DB.prepare("DROP TABLE staff").run();
    await d1.REC_2027.prepare("CREATE TABLE extra (id TEXT)").run();

    await resetMain(d1.DB);
    await resetLedger(d1.REC_2027);
    expect(await dump(d1.DB)).toEqual(fresh.db);
    expect(await dump(d1.REC_2027)).toEqual(fresh.rec);
  });
});
