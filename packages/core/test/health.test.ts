import { describe, expect, it } from "vitest";
import { PARTS, health } from "../src/index.ts";

describe("共通の部品", () => {
  it("部分は入口と作業場の 2 つ", () => {
    expect(PARTS).toEqual(["gate", "workspace"]);
  });

  it("どの部分の様子かを返す", () => {
    expect(health("gate")).toEqual({ ok: true, part: "gate" });
    expect(health("workspace")).toEqual({ ok: true, part: "workspace" });
  });
});
