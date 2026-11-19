// 同じ時に 1 つだけ動かす操作の錠。条件を重ねて取る時も、重ねない時も、1 文の条件付きの書きで取る (データの 2 章、サービスと拡張の 3.1)
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimLock, claimLockWhen } from "../../src/gate/db/locks.ts";
import { createTestD1, resetMain, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
}, 30_000);
afterAll(() => d1.dispose());
beforeEach(() => resetMain(d1.DB));

const NOW = 1_000_000;

describe("錠", () => {
  it("条件を重ねない時は今までどおり、空いた錠と切れた錠だけを取る", async () => {
    expect(await claimLock(d1.DB, { name: "x", holder: "a", now: NOW, ttlMs: 10 })).toBe(true);
    expect(await claimLock(d1.DB, { name: "x", holder: "b", now: NOW + 9, ttlMs: 10 })).toBe(false);
    expect(await claimLock(d1.DB, { name: "x", holder: "b", now: NOW + 10, ttlMs: 10 })).toBe(true);
  });

  it("条件が合わない時は、空いた錠も取らない", async () => {
    expect(await claimLockWhen(d1.DB, { name: "x", holder: "a", now: NOW, ttlMs: 10 }, sql`1 = 0`)).toBe(false);
    expect(await d1.DB.prepare("SELECT name FROM locks").all()).toMatchObject({ results: [] });
  });

  it("条件が合っても、ほかが持つ切れていない錠は取らず、切れた錠は取り直す", async () => {
    expect(await claimLockWhen(d1.DB, { name: "x", holder: "a", now: NOW, ttlMs: 10 }, sql`1 = 1`)).toBe(true);
    expect(await claimLockWhen(d1.DB, { name: "x", holder: "b", now: NOW + 9, ttlMs: 10 }, sql`1 = 1`)).toBe(false);
    expect(await claimLockWhen(d1.DB, { name: "x", holder: "b", now: NOW + 10, ttlMs: 10 }, sql`1 = 1`)).toBe(true);
    expect(await d1.DB.prepare("SELECT holder, until FROM locks").all()).toMatchObject({ results: [{ holder: "b", until: NOW + 20 }] });
  });
});
