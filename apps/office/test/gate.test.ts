import type { Health } from "@know-office/core";
import { describe, expect, it } from "vitest";
import gate from "../src/gate/index.ts";

describe("入口", () => {
  it("/api/health が入口の様子を返す", async () => {
    const res = await gate.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, part: "gate" } satisfies Health);
  });

  it("無い API は 404 を返す", async () => {
    const res = await gate.request("/api/nothing");
    expect(res.status).toBe(404);
  });
});

describe("画面から入口を呼ぶ口", () => {
  it("入口の道を型のとおりに呼び、様子を受け取る", async () => {
    const { createApi } = await import("../src/screen/api.ts");
    const api = createApi("http://office.test", async (input, init) => gate.request(input, init));
    const res = await api.api.health.$get();
    expect(await res.json()).toEqual({ ok: true, part: "gate" });
  });
});
