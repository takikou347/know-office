// 記録の量: 置き場ごとの使った量を返し、上限の 8 割に届いたら通知を出す (ログインと記録の 3.5、monitoring の「記録の量」)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkStorage, runScheduled } from "../../src/gate/jobs/health.ts";
import { STORAGE_LIMIT_BYTES } from "../../src/gate/ledger/storage.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
// テストごとに空の D1 とゲートウェイを作り、前のテストの通知に頼らない
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const StorageList = z.object({ data: z.array(z.object({ binding: z.string(), bytes: z.number(), ratio: z.number() })), meta: z.object({ next: z.string().nullable() }).loose() });

/**
 * 出ている通知を読む
 * @returns 種類と題
 */
async function notices(): Promise<unknown[]> {
  return (await d1.DB.prepare("SELECT kind, level, title FROM notices ORDER BY at").all()).results;
}

describe("記録の量", () => {
  it("8 割に届く", async () => {
    gate.storage["REC_2026"] = STORAGE_LIMIT_BYTES * 0.8;
    await checkStorage(gate.env, clock);
    expect(await notices()).toEqual([{ kind: "storage", level: "warn", title: "記録の置き場 REC_2026 が上限の 8 割に届いた" }]);
    const res = await gate.request("/api/v1/storage", { headers });
    expect(res.status).toBe(200);
    const { data } = StorageList.parse(await res.json());
    expect(data).toContainEqual({ binding: "REC_2026", bytes: STORAGE_LIMIT_BYTES * 0.8, ratio: 0.8 });
  });

  it("8 割に届かなければ通知を出さず、届いた通知は読むまで重ねて出さない", async () => {
    gate.storage["REC_2026"] = STORAGE_LIMIT_BYTES * 0.8 - 1;
    await checkStorage(gate.env, clock);
    expect(await notices()).toEqual([]);
    gate.storage["REC_2026"] = STORAGE_LIMIT_BYTES * 0.9;
    await checkStorage(gate.env, clock);
    await checkStorage(gate.env, clock);
    expect(await notices()).toHaveLength(1);
  });

  it("定期ジョブが失敗したら、投げずにエラーログに残す", async () => {
    const env = { ...gate.env, RECORDER: { idFromName: () => "id", get: () => ({ size: () => Promise.reject(new Error("記録 DO が応答しない")) }) } };
    const waits: Promise<unknown>[] = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    runScheduled(env as unknown as typeof gate.env, { waitUntil: (p: Promise<unknown>) => waits.push(p) }, clock);
    await Promise.all(waits);
    const { results } = await d1.REC_2026.prepare("SELECT source, level, code FROM error_events").all();
    expect(results).toEqual([{ source: "job", level: "error", code: "storage_check_failed" }]);
  });

  it("使った量の一覧は置き場の名前の順に limit ごとにページを送る", async () => {
    const first = StorageList.parse(await (await gate.request("/api/v1/storage?limit=2", { headers })).json());
    expect(first.data.map((use) => use.binding)).toEqual(["DB", "REC_2026"]);
    const second = StorageList.parse(await (await gate.request(`/api/v1/storage?limit=2&cursor=${String(first.meta.next)}`, { headers })).json());
    expect(second.data.map((use) => use.binding)).toEqual(["REC_2027"]);
    expect(second.meta.next).toBeNull();
  });
});
