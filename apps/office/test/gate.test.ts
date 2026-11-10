import type { Health } from "@know-office/core";
import { describe, expect, it } from "vitest";
import gate from "../src/gate/index.ts";

describe("入口", () => {
  it("/api/health が入口の様子を返す", async () => {
    const res = await gate.request("/api/health");
    expect(res.status).toBe(200);
    const body: Health = await res.json();
    expect(body).toEqual({ ok: true, part: "gate" });
  });

  it("無い API は 404 を返す", async () => {
    const res = await gate.request("/api/nothing");
    expect(res.status).toBe(404);
  });
});
