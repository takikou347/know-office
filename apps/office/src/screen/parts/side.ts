// 左のサイドメニューの開け閉め。閉じたかをブラウザに覚え、次に開いた時も同じにする
import { useCallback, useState } from "react";

/** 閉じたかを覚えるブラウザの置き場の名前 */
export const SIDE_KEY = "know-office:side-collapsed";

/**
 * 覚えた開け閉めを読む
 * @param storage 読む置き場。読めない時は無し
 * @returns 閉じていれば true
 */
export function storedSideCollapsed(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(SIDE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * サイドメニューの開け閉めの状態。変えるとブラウザに覚える
 * @returns 閉じているかと、変える関数
 */
export function useSideCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => storedSideCollapsed(typeof localStorage === "undefined" ? undefined : localStorage));
  const change = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDE_KEY, next ? "1" : "0");
    } catch {
      // 覚えられない時もその場では変える
    }
  }, []);
  return [collapsed, change];
}
