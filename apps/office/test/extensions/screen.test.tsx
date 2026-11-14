// 管理の拡張の画面。入れた拡張の画面は 8 の画面の後ろに並び、切ると消える (サービスと拡張の 3.8)
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../../src/screen/App.tsx";
import { EXTENSION_SCREENS, withScreens } from "../../src/screen/extensions.ts";
import { extensionPath, moreScreensWith, screenOf, sideItemsWith } from "../../src/screen/routes.ts";

const NOTES = { id: "sample-notes", title: "メモ", enabled: true, ownerData: false };

describe("差し込み口", () => {
  it("拡張を切る", () => {
    // 入れている間は、左の切り替えの 8 の画面の後ろと、その他に並ぶ
    expect(sideItemsWith(withScreens([NOTES])).map((i) => i.label).slice(7)).toEqual(["設定", "メモ"]);
    expect(moreScreensWith([NOTES]).map((s) => s.label)).toContain("メモ");
    expect(screenOf(extensionPath("sample-notes"), [NOTES]).label).toBe("メモ");
    expect(renderToString(<App url="/ext/sample-notes" extensions={[NOTES]} />)).toContain("メモを読んでいます");

    // 切ると、切り替えから消え、道はダッシュボードになる
    const off = { ...NOTES, enabled: false };
    expect(sideItemsWith(withScreens([off])).map((i) => i.label)).not.toContain("メモ");
    expect(moreScreensWith([off]).map((s) => s.label)).not.toContain("メモ");
    expect(screenOf(extensionPath("sample-notes"), [off]).id).toBe("dashboard");
    expect(renderToString(<App url="/ext/sample-notes" extensions={[off]} />)).not.toContain("メモを読んでいます");
  });

  it("土台を直さない", () => {
    // 画面は extensions/<名前>/screen.tsx に置いただけで集まる
    expect(Object.keys(EXTENSION_SCREENS)).toContain("sample-notes");
    // 画面の無い拡張は、入れても切り替えに出さない
    expect(withScreens([{ ...NOTES, id: "no-screen", title: "画面無し" }])).toEqual([]);
  });
});
