// 画面をサーバーで描いた HTML を返す。開いた時に読む画面 (src/screen/pages.tsx の lazy) も読み終えるまで待つ
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";

/**
 * 遅れて読む画面を読み終えてから、描いた HTML を返す。renderToString は読み終える前の「画面を読んでいます」を返すので、画面の中身を確かめる時はこちらを使う
 * @param node 描く物
 * @returns HTML
 */
export async function renderAll(node: ReactNode): Promise<string> {
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}
