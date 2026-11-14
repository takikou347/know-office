// 記録 DO を本物の workerd で確かめる。ログインと記録の 3.4、3.5
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

// テストごとに workerd と D1 を作り直し、前のテストが書いた行に頼らない
let worker: TestWorker;
beforeEach(async () => {
  worker = await startTestWorker();
}, 30_000);
afterEach(() => worker.dispose());

const at2026 = Date.UTC(2026, 10, 14, 3, 0, 0);
const at2027 = Date.UTC(2026, 11, 31, 15, 0, 0);
const entry = (at: number, n: number) => ({ at, actor: "system", action: "test.append", target: String(n), scope: "office", detail: { n } });

describe("監査ログ", () => {
  it("並行して書いてもハッシュチェーンが割れない", async () => {
    // 往復ごとに wrangler の入口を通るので、並びを保ったまま負荷の高い時も 5 秒に収まる 40 件にする
    await Promise.all(Array.from({ length: 40 }, (_, n) => worker.call("append", entry(at2026, n))));
    expect(await worker.call("verify", 2026)).toMatchObject({ ok: true, brokenAt: null });
    expect(await worker.query("REC_2026", "SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 40 }]);
  });

  it("年をまたぐと前の年を readonly にし、前の年の最後のハッシュから続ける", async () => {
    await worker.call("append", entry(at2026, 0));
    const [last] = z.array(z.object({ hash: z.string() })).parse(await worker.query("REC_2026", "SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1"));
    await worker.call("append", entry(at2027, 0));
    expect(await worker.query("REC_2027", "SELECT prev_hash FROM audit_log")).toEqual([{ prev_hash: last?.hash }]);
    expect(await worker.query("DB", "SELECT year, binding, state, last_hash FROM record_years ORDER BY year")).toEqual([
      { year: 2026, binding: "REC_2026", state: "readonly", last_hash: last?.hash },
      { year: 2027, binding: "REC_2027", state: "writing", last_hash: null },
    ]);
    expect(await worker.call("verify", 2027)).toMatchObject({ ok: true });
  });

  it("readonly にした年には書けず、年をまたぐチェーンが割れない", async () => {
    await worker.call("append", entry(at2026, 0));
    await worker.call("append", entry(at2027, 0));
    await expect(worker.call("append", entry(at2026, 1))).rejects.toThrow(/2026 年の記録は readonly/);
    expect(await worker.query("REC_2026", "SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 1 }]);
    expect(await worker.call("verify", 2027)).toMatchObject({ ok: true });
  });

  it("形の違う入力は書かずに断る", async () => {
    await expect(worker.call("append", { at: at2026, actor: "system" })).rejects.toThrow(/監査ログの形が違う/);
    expect(await worker.query("REC_2026", "SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 0 }]);
  });
});
