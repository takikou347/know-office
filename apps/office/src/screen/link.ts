// 画面の中のリンクを押した時に、読み込み直さずに道だけを変えるかを決める

export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  link: { href: string; attr: (name: string) => string | null };
}

/**
 * リンクを押した時に、画面の中で移るかを決める
 * @param e 押した出来事と押したリンク
 * @param here 今の URL の源、パス、クエリ
 * @returns 画面の中で移る時は移る先 (パス、クエリ、ハッシュ)、ブラウザに任せる時は null
 */
export function routeOfClick(e: ClickLike, here: { origin: string; pathname: string; search: string }): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const { link } = e;
  if (link.attr("target") || link.attr("download") !== null) return null;
  if ((link.attr("rel") ?? "").split(/\s+/).includes("external")) return null;
  const to = new URL(link.href);
  if (to.origin !== here.origin) return null;
  if (to.pathname === "/api" || to.pathname.startsWith("/api/")) return null;
  if (to.hash && to.pathname === here.pathname && to.search === here.search) return null;
  return to.pathname + to.search + to.hash;
}
