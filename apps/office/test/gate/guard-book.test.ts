// GuardBook の記憶が送信元の数だけ増え続けない事を確かめる。DO を通した数え方は test/do/guard.test.ts
import { describe, expect, it } from "vitest";
import { GuardBook } from "../../src/gate/auth/guard-book.ts";

const start = Date.UTC(2026, 10, 14, 3, 0, 0);

describe("総当たりと怪しい動き", () => {
  it("レート制限の数は、分が変わると前の分の送信元を忘れる", async () => {
    const storage = { get: () => Promise.resolve(undefined), put: () => Promise.resolve(), delete: () => Promise.resolve(false) };
    const book = new GuardBook(storage, () => Promise.resolve());
    for (let n = 0; n < 100; n += 1) await book.admit(`203.0.113.${String(n)}`, "api", start);
    expect(book.tracked).toBe(100);
    await book.admit("203.0.113.1", "api", start + 60_000);
    expect(book.tracked).toBe(1);
  });
});
