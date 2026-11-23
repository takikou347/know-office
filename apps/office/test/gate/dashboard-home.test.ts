// ホームの数値: 今月の日ごとの費用と、動いているサービスごとの数値を入口の /dashboard から返す (タスクとレビューの 3.4、サービスと拡張の 3.2)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const at = (day: number, h: number) => Date.UTC(2026, 10, day, h - 9);
const USAGE = "INSERT INTO usage (id, at, staff_id, node_id, scope, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd) VALUES (?, ?, 'builder', NULL, ?, 'm', 0, 0, 0, 0, ?)";
const WEB = "019a7b00-0000-7000-8000-0000000000e1";
const IDEA = "019a7b00-0000-7000-8000-0000000000e2";
const LIB = "019a7b00-0000-7000-8000-0000000000e3";

let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock: fixedClock(at(3, 10)), d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const Home = z.object({
  data: z
    .object({
      dailyCosts: z.array(z.object({ day: z.string(), costMicroUsd: z.number() }).strict()),
      services: z.array(z.object({ id: z.string(), name: z.string(), stage: z.string(), status: z.object({ kind: z.string() }).loose() }).loose()),
    })
    .loose(),
});

/**
 * ホームの数値を読む
 * @returns 日ごとの費用とサービス
 */
async function home(): Promise<z.infer<typeof Home>["data"]> {
  const res = await gate.request("/api/v1/dashboard", { headers });
  expect(res.status).toBe(200);
  return Home.parse(await res.json()).data;
}

describe("記録に出す値", () => {
  it("今月の 1 日から今日までの日ごとの費用を、日本時間の日で分けて返す", async () => {
    const usage = d1.REC_2026.prepare(USAGE);
    // 日本時間の 11 月 1 日 0 時ちょうどは 1 日、その 1 ミリ秒前は先月。2 日は使っていない
    await d1.REC_2026.batch([
      usage.bind("019a7b00-0000-7000-8000-0000000000b1", Date.UTC(2026, 9, 31, 15), "office", 1_000_000),
      usage.bind("019a7b00-0000-7000-8000-0000000000b2", Date.UTC(2026, 9, 31, 15) - 1, "office", 9_000_000),
      usage.bind("019a7b00-0000-7000-8000-0000000000b3", at(3, 9), "office", 250_000),
      usage.bind("019a7b00-0000-7000-8000-0000000000b4", at(3, 9), WEB, 50_000),
    ]);
    expect((await home()).dailyCosts).toEqual([
      { day: "2026-11-01", costMicroUsd: 1_000_000 },
      { day: "2026-11-02", costMicroUsd: 0 },
      { day: "2026-11-03", costMicroUsd: 300_000 },
    ]);
  });

  it("試作、サービス、運用のサービスだけを、種類ごとの数値と一緒に返す", async () => {
    const insert = d1.DB.prepare("INSERT INTO services (id, name, kind, stage, repo, staff_id, created_at) VALUES (?, ?, ?, ?, NULL, 'builder', 1)");
    await d1.DB.batch([insert.bind(WEB, "家計の Web", "web_app", "service"), insert.bind(IDEA, "まだ案", "web_app", "idea"), insert.bind(LIB, "部品", "library", "operation")]);
    await d1.REC_2026.prepare(USAGE).bind("019a7b00-0000-7000-8000-0000000000b5", at(3, 9), WEB, 120_000).run();
    const services = (await home()).services;
    // マイグレーションが置く knowidea-ui と know-office も、ID の順で先に並ぶ
    expect(services.map((s) => `${s.name} ${s.stage} ${s.status.kind}`)).toEqual(["knowidea-ui operation library", "know-office prototype web_app", "家計の Web service web_app", "部品 operation library"]);
    expect(services.find((s) => s.id === WEB)?.status).toMatchObject({ costMicroUsd: 120_000 });
  });

  it("使った物が無ければ、日ごとの費用は 1 日から今日まで 0 で並ぶ", async () => {
    const data = await home();
    expect(data.dailyCosts.map((d) => d.costMicroUsd)).toEqual([0, 0, 0]);
  });
});
