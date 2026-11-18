// 設計書を同じ時に直すツールの入力の形。docs_pr_open は設計書の PR を出し、pr_open の docsPr はコードの PR に結ぶ (開発の回し方の 3.6)
import { describe, expect, it } from "vitest";
import { DocsPrOpenTool, PrOpenTool } from "../src/index.ts";

describe("設計書を同じ時に直す", () => {
  it("docs_pr_open は name と title と body だけを受ける", () => {
    expect(DocsPrOpenTool.safeParse({ name: "spec", title: "設計書", body: "" }).success).toBe(true);
    expect(DocsPrOpenTool.safeParse({ name: "spec", title: "設計書", body: "", docsPr: 1 }).success).toBe(false);
    expect(DocsPrOpenTool.safeParse({ name: "Spec", title: "設計書", body: "" }).success).toBe(false);
  });

  it("pr_open の docsPr は正の整数だけを受ける", () => {
    expect(PrOpenTool.safeParse({ title: "コード", body: "", docsPr: 3 }).success).toBe(true);
    for (const docsPr of [0, -1, 1.5, "3"]) expect(PrOpenTool.safeParse({ title: "コード", body: "", docsPr }).success).toBe(false);
  });

  it("pr_open はブランチの名前を受けない。ブランチはタスクを取った時に決まる", () => {
    expect(PrOpenTool.safeParse({ name: "code", title: "コード", body: "" }).success).toBe(false);
  });
});
