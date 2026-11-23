// 画面の明るさ (ライトとダーク) の切り替え。選んだ物をブラウザに覚え、html の data-theme で knowidea-tokens の色を替える。選ぶ前は端末の設定に合わせる
import { Icon, IconButton } from "knowidea-ui";
import { useCallback, useState } from "react";

/** 選べる明るさ */
export type ThemeMode = "light" | "dark";

/** 選んだ明るさを覚えるブラウザの置き場の名前 */
export const THEME_KEY = "know-office:theme";

/**
 * 覚えた明るさを読む
 * @param storage 読む置き場。読めない時は無し
 * @returns 覚えた明るさ。覚えていない時と形が違う時は null
 */
export function storedTheme(storage: Pick<Storage, "getItem"> | undefined): ThemeMode | null {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 覚えた明るさを html に付ける。画面を描く前に 1 度呼び、ちらつきを防ぐ
 * @param root 付ける要素
 * @param mode 明るさ。null の時は外して端末の設定に合わせる
 */
export function applyTheme(root: Pick<HTMLElement, "dataset">, mode: ThemeMode | null): void {
  if (mode) root.dataset.theme = mode;
  else delete root.dataset.theme;
}

/**
 * 今見えている明るさ。選んでいない時は端末の設定から決める
 * @returns ライトかダーク
 */
function shownTheme(): ThemeMode {
  if (typeof document === "undefined") return "light";
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * 上のバーに置く、ライトとダークを切り替えるボタン
 * @returns ボタン
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(shownTheme);
  const toggle = useCallback(() => {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    applyTheme(document.documentElement, next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 覚えられない時もその場では切り替える
    }
    setMode(next);
  }, [mode]);
  const toDark = mode === "light";
  return <IconButton label={toDark ? "ダークにする" : "ライトにする"} icon={<Icon name={toDark ? "moon" : "sun"} />} onClick={toggle} />;
}
