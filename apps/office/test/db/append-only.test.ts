// 追記専用テーブルが書き換えと消すを断る事を確かめる。データの 3.2
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAIN_APPEND_ONLY } from "../../src/gate/db/main.ts";
import { RECORD_TABLES } from "../../src/gate/db/records.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
});
afterAll(() => d1.dispose());

describe("追記専用の記録", () => {
  it.each(MAIN_APPEND_ONLY)("DB の %s は書き換えと消すを断る", async (table) => {
    const triggers = await d1.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").bind(table).all<{ name: string }>();
    expect(triggers.results.map((r) => r.name).toSorted()).toEqual([`${table}_no_delete`, `${table}_no_update`]);
  });

  it.each(RECORD_TABLES)("REC_<年> の %s は書き換えと消すを断る", async (table) => {
    const triggers = await d1.REC_2026.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").bind(table).all<{ name: string }>();
    expect(triggers.results.map((r) => r.name).toSorted()).toEqual([`${table}_no_delete`, `${table}_no_update`]);
  });

  it("書き換えようとすると append only で止まる", async () => {
    await d1.DB.prepare("INSERT INTO login_attempts (id, at, ip, kind, ok) VALUES ('a', 1, '1.1.1.1', 'access', 0)").run();
    await expect(d1.DB.prepare("UPDATE login_attempts SET ok = 1").run()).rejects.toThrow("append only");
    await expect(d1.DB.prepare("DELETE FROM login_attempts").run()).rejects.toThrow("append only");
  });
});
