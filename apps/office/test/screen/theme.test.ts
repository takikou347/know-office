// 画面の明るさの切り替え。覚えた物を読み、html に付ける (画面の全体の 3.3)
import { describe, expect, it } from "vitest";
import { applyTheme, storedTheme, THEME_KEY } from "../../src/screen/parts/theme.tsx";

/**
 * 覚えた値を返す置き場を作る
 * @param v 覚えた値
 * @returns 置き場
 */
function store(v: string | null) {
  return { getItem: (k: string) => (k === THEME_KEY ? v : null) };
}

describe("画面の明るさ", () => {
  it("覚えたライトとダークだけを読み、ほかは端末に合わせる", () => {
    expect(storedTheme(store("dark"))).toBe("dark");
    expect(storedTheme(store("light"))).toBe("light");
    expect(storedTheme(store("blue"))).toBeNull();
    expect(storedTheme(undefined)).toBeNull();
  });

  it("選んだ明るさを html の data-theme に付け、選ばない時は外す", () => {
    const root = { dataset: {} satisfies DOMStringMap };
    applyTheme(root, "dark");
    expect(root.dataset.theme).toBe("dark");
    applyTheme(root, null);
    expect(root.dataset.theme).toBeUndefined();
  });
});
