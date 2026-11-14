// 稼働確認が D1 を確かめる事を確かめる。ルートの一覧の 1.1
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import gate from "../../src/gate/index.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
});
afterAll(() => d1.dispose());

describe("稼働確認", () => {
  it("D1 が応答すれば 200 でゲートウェイが動いている事を返す", async () => {
    const res = await gate.request("/api/v1/health", {}, { DB: d1.DB });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, part: "gate" } });
  });

  it("D1 が応答しなければ 503 unavailable", async () => {
    const broken: Pick<D1Database, "prepare"> = {
      prepare: () => {
        throw new Error("D1 が止まっている");
      },
    };
    const res = await gate.request("/api/v1/health", {}, { DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "unavailable" });
  });
});
