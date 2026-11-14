// 全体のセキュリティ DO を本物の workerd で確かめる。ログインと記録の 1.2、3.1 の 4、API の決まりの 1.2
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

// テストごとに workerd と D1 を作り直し、前のテストの数に頼らない
let worker: TestWorker;
beforeEach(async () => {
  worker = await startTestWorker();
}, 30_000);
afterEach(() => worker.dispose());

const start = Date.UTC(2026, 10, 14, 3, 0, 0);
const MINUTE = 60_000;

describe("総当たりと怪しい動き", () => {
  it("総当たり", async () => {
    for (let n = 0; n < 4; n += 1) await worker.guard("fail", "203.0.113.1", start + n * MINUTE);
    expect(await worker.guard("admit", "203.0.113.1", "api", start + 4 * MINUTE)).toEqual({ locked: false, retryAfter: null });
    // 10 分のうちの 5 回目でロックアウトし、オーナーに通知を出す
    expect(await worker.guard("fail", "203.0.113.1", start + 9 * MINUTE)).toEqual({ locked: true });
    expect(await worker.guard("admit", "203.0.113.1", "api", start + 10 * MINUTE)).toEqual({ locked: true, retryAfter: null });
    expect(await worker.query("DB", "SELECT level, kind FROM notices")).toEqual([{ level: "warn", kind: "lockout" }]);
    // ほかの送信元は止めない
    expect(await worker.guard("admit", "203.0.113.2", "api", start + 10 * MINUTE)).toEqual({ locked: false, retryAfter: null });
    // 15 分で解ける
    expect(await worker.guard("admit", "203.0.113.1", "api", start + 24 * MINUTE + 1)).toEqual({ locked: false, retryAfter: null });
  });

  it("10 分より前の失敗は数えない", async () => {
    for (let n = 0; n < 4; n += 1) await worker.guard("fail", "203.0.113.1", start + n * MINUTE);
    expect(await worker.guard("fail", "203.0.113.1", start + 11 * MINUTE)).toEqual({ locked: false });
  });

  it("送信元ごとに 1 分 300 回を超えると、次の分までの秒数を返す", async () => {
    for (let n = 0; n < 300; n += 1) expect(await worker.guard("admit", "203.0.113.1", "api", start + 1000)).toEqual({ locked: false, retryAfter: null });
    expect(await worker.guard("admit", "203.0.113.1", "api", start + 1000)).toEqual({ locked: false, retryAfter: 59 });
    expect(await worker.guard("admit", "203.0.113.1", "api", start + MINUTE)).toEqual({ locked: false, retryAfter: null });
  });

  it("ログインとパスキーは 1 分 10 回", async () => {
    for (let n = 0; n < 10; n += 1) await worker.guard("admit", "203.0.113.1", "auth", start);
    expect(await worker.guard("admit", "203.0.113.1", "auth", start)).toEqual({ locked: false, retryAfter: 60 });
  });
});

describe("大事な操作の前にパスキーで確かめる", () => {
  it("challenge は 1 度だけ、5 分のうちだけ取り出せる", async () => {
    await worker.guard("putChallenge", "s1", { challenge: "c1", purpose: "step_up" }, start);
    expect(await worker.guard("takeChallenge", "s1", start + 4 * MINUTE)).toEqual({ challenge: "c1", purpose: "step_up" });
    expect(await worker.guard("takeChallenge", "s1", start + 4 * MINUTE)).toBeNull();
    await worker.guard("putChallenge", "s2", { challenge: "c2", purpose: "register" }, start);
    expect(await worker.guard("takeChallenge", "s2", start + 5 * MINUTE + 1)).toBeNull();
  });
});
