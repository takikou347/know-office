// ハーネスの画面の並びと空の時の文。上から確かめて設定できるよう、今止まっている物、基準の設定、止めた記録、学びの順に見出しを置き、空の部分は「〜はありません」と出す (自動停止の 3.6)
import { describe, expect, it } from "vitest";
import { Table } from "knowidea-ui";
import { renderToString } from "react-dom/server";
import { App } from "../../src/screen/App.tsx";
import { EMPTY_TEXT } from "../../src/screen/pages/guard/labels.ts";
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

  it("空の時の文", () => {
    // どの部分の文も「〜はありません」の形で、「無い」「まだ」を使わない
    for (const text of Object.values(EMPTY_TEXT)) {
      expect(text).toMatch(/^.+はありません$/);
      expect(text).not.toMatch(/無い|まだ/);
    }
    // 行の無い表は、渡した文を出す
    const html = renderToString(<Table label="止めた記録" rowKey={(r: { id: string }) => r.id} rows={[]} emptyText={EMPTY_TEXT.history} columns={[{ key: "id", header: "ID" }]} />);
    expect(html).toContain("止めた記録はありません");
  });
});
