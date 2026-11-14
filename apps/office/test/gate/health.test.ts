// 稼働確認が D1 を確かめる事を確かめる。ルートの一覧の 1.1
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

let d1: TestD1;
let gate: TestGate;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock: fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0)), d1 });
});
afterEach(() => d1.dispose());

describe("稼働確認", () => {
  it("D1 が応答すれば 200 でゲートウェイが動いている事を返す", async () => {
    const res = await gate.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, part: "gate" } });
  });

  it("D1 が応答しなければ 503 unavailable。ログインセッションは D1 に要るので、稼働確認は Access の証明だけで答える", async () => {
    const broken: Pick<D1Database, "prepare"> = {
      prepare: () => {
        throw new Error("D1 が止まっている");
      },
    };
    const res = await gate.app.request("/api/v1/health", { headers: { "Cf-Access-Jwt-Assertion": await gate.access.sign() } }, { ...gate.env, DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "unavailable" });
  });
});
