import { describe, expect, it } from "vitest";
import { bottomCurrentOf, bottomItems, moreScreens, screenOf, screens, sideItems, titleOf } from "../src/screen/routes.ts";

describe("画面の一覧", () => {
  it("8 つの画面を持ち、最初はダッシュボード", () => {
    expect(screens.map((s) => s.label)).toEqual([
      "ダッシュボード",
      "社員と仕事",
      "目的と組織図",
      "オフィス",
      "アイデアとサービス",
      "守り",
      "記録",
      "設定",
    ]);
    expect(screens[0]?.path).toBe("/");
  });

  it("左の切り替えには 8 つすべて、下には 5 つまで", () => {
    expect(sideItems).toHaveLength(8);
    expect(bottomItems.length).toBeLessThanOrEqual(5);
    expect(bottomItems.at(-1)?.label).toBe("その他");
  });

  it("どの画面も、下の切り替えかその他のどちらかから行ける", () => {
    const bottom = new Set(bottomItems.map((i) => i.href));
    const more = new Set(moreScreens.map((s) => s.path));
    for (const s of screens) expect(bottom.has(s.path) || more.has(s.path)).toBe(true);
  });

  it("道から画面を決め、知らない道はダッシュボードにする", () => {
    expect(screenOf("/records").label).toBe("記録");
    expect(screenOf("/staff/builder").label).toBe("社員と仕事");
    expect(screenOf("/nowhere").label).toBe("ダッシュボード");
  });

  it("下の切り替えの印は、下に無い画面とその他で「その他」に付く", () => {
    expect(bottomCurrentOf("/guard")).toBe("guard");
    expect(bottomCurrentOf("/staff/builder")).toBe("staff");
    expect(bottomCurrentOf("/records")).toBe("more");
    expect(bottomCurrentOf("/more")).toBe("more");
  });

  it("ブラウザの題は画面の名前にする", () => {
    expect(titleOf("/records")).toBe("記録 - know-office");
    expect(titleOf("/more")).toBe("その他 - know-office");
  });
});
