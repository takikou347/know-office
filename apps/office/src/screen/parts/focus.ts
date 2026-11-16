// focus した物を、中身の段 (main) の見える所に全部入れる
import { useEffect } from "react";

/**
 * 中身 (main) の中で focus している物を、隠れないよう見える所へ寄せる。中身の外の focus (帯の「読んだ」など) は動かさない
 * @param doc 画面の文書
 */
export function revealFocus(doc: Document): void {
  const focused = doc.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.closest("main")) return;
  focused.scrollIntoView({ block: "nearest" });
}

/**
 * focus が中身の物に移るたびに、その物を全部見える所へ寄せる。ブラウザーは少しでも見えている物には送らず、textarea では
 * 入力の位置の行までしか寄せないので、中身の段の下の端で切れたまま下の切り替えに隠れる (WCAG 2.2 の 2.4.11)
 */
export function useRevealFocus(): void {
  useEffect(() => {
    const reveal = (e: FocusEvent) => {
      if (e.target instanceof Node) revealFocus(e.target.ownerDocument ?? document);
    };
    document.addEventListener("focusin", reveal);
    return () => document.removeEventListener("focusin", reveal);
  }, []);
}
