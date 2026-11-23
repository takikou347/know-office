// 設定の画面のカードの形。見出し、1 行の説明、今の値、右下の編集のボタンを出し、組み込みの初期値の印を出さない。空の値は「〜はありません」と書く (サービスと拡張の 3.3)
import type { Setting } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { scheduleText } from "../../src/screen/pages/settings/OfficeRules.tsx";
import { RuleCard, ruleText } from "../../src/screen/parts/rule-card.tsx";

const SETTING: Setting = { key: "service.mergeWhen", value: ["checks"], version: 3, inherited: true };

describe("設定の画面のカード", () => {
  it("見出し、説明、今の値と編集のボタンを出し、組み込みの初期値もバージョンも出さない", () => {
    const html = renderToString(<RuleCard setting={SETTING} name="mergeWhen" put={() => Promise.reject(new Error("送らない"))} onSaved={() => undefined} onRefused={() => undefined} />);
    expect(html).toMatch(/<h3[^>]*>main にマージする条件<\/h3>/);
    expect(html).toContain("社員の PR を main に入れる前にそろえる条件です");
    expect(html).toContain("<strong>チェックの合格</strong>");
    expect(html).toContain('aria-label="main にマージする条件を編集"');
    // 編集を押す前は、入力も理由の欄も出さない
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("変える理由");
    expect(html).not.toContain("組み込みの初期値");
    expect(html).not.toContain("バージョン");
  });

  it("空の値は「〜はありません」と書く", () => {
    expect(ruleText("actions", [])).toBe("できる操作はありません");
    expect(ruleText("protectedPaths", [])).toBe("触れない所はありません");
    expect(ruleText("paused", false)).toBe("動かしています");
    expect(scheduleText({ start: "09:00", end: "17:00", days: [1, 2] })).toBe("09:00 から 17:00 (日本時間)、月・火");
  });
});
