// ハーネスの画面の並び。上から確かめて設定できるよう、今止まっている物、基準の設定、止めた記録、学びの順に見出しを置く (自動停止の 3.6)
import { describe, expect, it } from "vitest";
import { App } from "../../src/screen/App.tsx";
import { renderAll } from "../helpers/render.ts";

/**
 * 描いた HTML から、2 段目の見出しの文を上から順に取る
 * @param html 描いた HTML
 * @returns 見出しの文の並び
 */
function partTitles(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1] ?? "");
}

describe("ハーネスの画面", () => {
  it("上から並ぶ", async () => {
    const html = await renderAll(<App url="/guard" />);
    expect(partTitles(html)).toEqual(["今止まっている物", "基準の設定", "止めた記録", "学び"]);
  });
});
